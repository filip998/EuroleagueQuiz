from __future__ import annotations

from dataclasses import dataclass
import json
import threading
import time
from typing import Any, Callable, Mapping

import httpx
import jwt
from jwt import InvalidTokenError, PyJWTError
from jwt.algorithms import RSAAlgorithm

from app.config import settings


class ClerkAuthConfigurationError(RuntimeError):
    pass


class ClerkAuthError(ValueError):
    pass


class ClerkTokenError(ClerkAuthError):
    pass


JWKSFetcher = Callable[[str], Mapping[str, Any]]
Clock = Callable[[], float]


def parse_authorized_parties(raw_value: str | None) -> tuple[str, ...]:
    if not raw_value:
        return ()
    return tuple(party.strip() for party in raw_value.split(",") if party.strip())


def extract_bearer_token(authorization: str | None) -> str:
    if authorization is None:
        raise ClerkTokenError("Missing bearer token")
    scheme, separator, token = authorization.strip().partition(" ")
    if scheme.lower() != "bearer" or not separator or not token.strip():
        raise ClerkTokenError("Invalid authorization header")
    token = token.strip()
    if " " in token:
        raise ClerkTokenError("Invalid bearer token")
    return token


def _default_fetch_jwks(url: str) -> Mapping[str, Any]:
    try:
        response = httpx.get(url, timeout=5.0)
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ClerkTokenError("Unable to fetch Clerk JWKS") from exc
    if not isinstance(payload, Mapping):
        raise ClerkTokenError("Invalid Clerk JWKS response")
    return payload


@dataclass(frozen=True)
class _CachedJWKS:
    keys_by_kid: dict[str, Mapping[str, Any]]
    fetched_at: float
    last_unknown_kid_refresh_at: float


@dataclass
class _InFlightJWKSFetch:
    event: threading.Event
    result: _CachedJWKS | None = None
    error: Exception | None = None


class JWKSCache:
    def __init__(
        self,
        *,
        fetcher: JWKSFetcher = _default_fetch_jwks,
        ttl_seconds: float = 300.0,
        refresh_cooldown_seconds: float = 30.0,
        unknown_kid_refresh_limit: int = 2,
        clock: Clock = time.monotonic,
    ) -> None:
        self._fetcher = fetcher
        self._ttl_seconds = ttl_seconds
        self._refresh_cooldown_seconds = refresh_cooldown_seconds
        self._unknown_kid_refresh_limit = max(1, unknown_kid_refresh_limit)
        self._clock = clock
        self._cache: dict[str, _CachedJWKS] = {}
        self._in_flight_fetches: dict[str, _InFlightJWKSFetch] = {}
        self._unknown_kid_refreshes: dict[str, list[tuple[str, float]]] = {}
        self._lock = threading.RLock()

    def get_key(self, jwks_url: str, kid: str) -> Mapping[str, Any]:
        cached, refreshed = self._get_cached(jwks_url)
        key = cached.keys_by_kid.get(kid)
        if key is not None:
            return key

        if not refreshed:
            cached = self._refresh_for_unknown_kid(jwks_url, kid)
            key = cached.keys_by_kid.get(kid)
            if key is not None:
                return key

        raise ClerkTokenError("Unknown Clerk signing key")

    def _get_cached(self, jwks_url: str) -> tuple[_CachedJWKS, bool]:
        now = self._clock()
        with self._lock:
            cached = self._cache.get(jwks_url)
            if cached is not None and now - cached.fetched_at < self._ttl_seconds:
                return cached, False
        return self._fetch_and_store(jwks_url, now=now, minimum_fetched_at=now), True

    def _refresh_for_unknown_kid(self, jwks_url: str, kid: str) -> _CachedJWKS:
        now = self._clock()
        wait_for: _InFlightJWKSFetch | None = None
        with self._lock:
            cached = self._cache.get(jwks_url)
            if cached is not None and kid in cached.keys_by_kid:
                return cached
            if cached is not None:
                in_flight = self._in_flight_fetches.get(jwks_url)
                if in_flight is not None:
                    wait_for = in_flight
                elif not self._reserve_unknown_kid_refresh(jwks_url, kid, now):
                    return cached
        if wait_for is not None:
            return self._wait_for_fetch(wait_for)
        return self._fetch_and_store(
            jwks_url,
            now=now,
            last_unknown_kid_refresh_at=now,
        )

    def _fetch_and_store(
        self,
        jwks_url: str,
        *,
        now: float,
        last_unknown_kid_refresh_at: float | None = None,
        minimum_fetched_at: float | None = None,
    ) -> _CachedJWKS:
        with self._lock:
            cached = self._cache.get(jwks_url)
            if minimum_fetched_at is not None and cached is not None and cached.fetched_at >= minimum_fetched_at:
                return cached
            in_flight = self._in_flight_fetches.get(jwks_url)
            if in_flight is None:
                if last_unknown_kid_refresh_at is not None and cached is not None:
                    self._cache[jwks_url] = _CachedJWKS(
                        keys_by_kid=cached.keys_by_kid,
                        fetched_at=cached.fetched_at,
                        last_unknown_kid_refresh_at=last_unknown_kid_refresh_at,
                    )
                in_flight = _InFlightJWKSFetch(event=threading.Event())
                self._in_flight_fetches[jwks_url] = in_flight
                owns_fetch = True
            else:
                owns_fetch = False

        if not owns_fetch:
            return self._wait_for_fetch(in_flight)

        try:
            jwks = self._fetcher(jwks_url)
            with self._lock:
                previous = self._cache.get(jwks_url)
                cached = _CachedJWKS(
                    keys_by_kid=_keys_by_kid(jwks),
                    fetched_at=now,
                    last_unknown_kid_refresh_at=(
                        previous.last_unknown_kid_refresh_at
                        if last_unknown_kid_refresh_at is None and previous is not None
                        else last_unknown_kid_refresh_at or 0.0
                    ),
                )
                self._cache[jwks_url] = cached
                in_flight.result = cached
                return cached
        except Exception as exc:
            with self._lock:
                in_flight.error = exc
            raise
        finally:
            with self._lock:
                self._in_flight_fetches.pop(jwks_url, None)
                in_flight.event.set()

    def _wait_for_fetch(self, in_flight: _InFlightJWKSFetch) -> _CachedJWKS:
        in_flight.event.wait()
        if in_flight.error is not None:
            raise in_flight.error
        if in_flight.result is None:
            raise ClerkTokenError("Unable to fetch Clerk JWKS")
        return in_flight.result

    def _reserve_unknown_kid_refresh(self, jwks_url: str, kid: str, now: float) -> bool:
        refreshes = [
            (refreshed_kid, refreshed_at)
            for refreshed_kid, refreshed_at in self._unknown_kid_refreshes.get(jwks_url, [])
            if now - refreshed_at < self._refresh_cooldown_seconds
        ]
        self._unknown_kid_refreshes[jwks_url] = refreshes
        if any(refreshed_kid == kid for refreshed_kid, _ in refreshes):
            return False
        if len(refreshes) >= self._unknown_kid_refresh_limit:
            return False
        refreshes.append((kid, now))
        return True


def _keys_by_kid(jwks: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    raw_keys = jwks.get("keys")
    if not isinstance(raw_keys, list):
        raise ClerkTokenError("Invalid Clerk JWKS keys")

    keys: dict[str, Mapping[str, Any]] = {}
    for key in raw_keys:
        if not isinstance(key, Mapping):
            continue
        kid = key.get("kid")
        if (
            isinstance(kid, str)
            and key.get("kty") == "RSA"
            and key.get("use") in (None, "sig")
            and key.get("alg") in (None, "RS256")
        ):
            keys[kid] = key
    return keys


class ClerkJWTVerifier:
    def __init__(
        self,
        *,
        issuer: str,
        jwks_url: str,
        authorized_parties: tuple[str, ...] = (),
        leeway_seconds: int = 60,
        jwks_cache: JWKSCache | None = None,
    ) -> None:
        if not issuer:
            raise ClerkAuthConfigurationError("Clerk issuer is not configured")
        if not jwks_url:
            raise ClerkAuthConfigurationError("Clerk JWKS URL is not configured")
        self._issuer = issuer.rstrip("/")
        self._jwks_url = jwks_url
        self._authorized_parties = frozenset(authorized_parties)
        self._leeway_seconds = leeway_seconds
        self._jwks_cache = jwks_cache or JWKSCache(
            ttl_seconds=settings.clerk_jwks_cache_ttl_seconds,
            refresh_cooldown_seconds=settings.clerk_jwks_refresh_cooldown_seconds,
        )

    @classmethod
    def from_settings(cls) -> "ClerkJWTVerifier":
        if not settings.clerk_issuer or not settings.clerk_jwks_url:
            raise ClerkAuthConfigurationError("ELQ_CLERK_ISSUER and ELQ_CLERK_JWKS_URL are required")
        return cls(
            issuer=settings.clerk_issuer,
            jwks_url=settings.clerk_jwks_url,
            authorized_parties=parse_authorized_parties(settings.clerk_authorized_parties),
            leeway_seconds=settings.clerk_jwt_leeway_seconds,
            jwks_cache=JWKSCache(
                ttl_seconds=settings.clerk_jwks_cache_ttl_seconds,
                refresh_cooldown_seconds=settings.clerk_jwks_refresh_cooldown_seconds,
            ),
        )

    def verify(self, token: str) -> Mapping[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
        except InvalidTokenError as exc:
            raise ClerkTokenError("Invalid Clerk token header") from exc

        kid = header.get("kid")
        alg = header.get("alg")
        if not isinstance(kid, str) or not kid:
            raise ClerkTokenError("Missing Clerk token key id")
        if alg != "RS256":
            raise ClerkTokenError("Unsupported Clerk token algorithm")

        jwk = self._jwks_cache.get_key(self._jwks_url, kid)
        try:
            public_key = RSAAlgorithm.from_jwk(json.dumps(jwk))
            claims = jwt.decode(
                token,
                public_key,
                algorithms=["RS256"],
                issuer=self._issuer,
                leeway=self._leeway_seconds,
                options={
                    "require": ["iss", "sub", "exp"],
                    "verify_aud": False,
                },
            )
        except (PyJWTError, TypeError, ValueError) as exc:
            raise ClerkTokenError("Invalid Clerk token") from exc

        if not isinstance(claims, Mapping):
            raise ClerkTokenError("Invalid Clerk token claims")
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            raise ClerkTokenError("Invalid Clerk token subject")
        self._validate_authorized_party(claims)
        return claims

    def _validate_authorized_party(self, claims: Mapping[str, Any]) -> None:
        if not self._authorized_parties:
            return
        azp = claims.get("azp")
        if not isinstance(azp, str) or azp not in self._authorized_parties:
            raise ClerkTokenError("Invalid Clerk authorized party")


_default_verifier: ClerkJWTVerifier | None = None
_default_verifier_lock = threading.Lock()


def get_clerk_jwt_verifier() -> ClerkJWTVerifier:
    global _default_verifier
    if _default_verifier is None:
        with _default_verifier_lock:
            if _default_verifier is None:
                _default_verifier = ClerkJWTVerifier.from_settings()
    return _default_verifier


def reset_clerk_jwt_verifier() -> None:
    global _default_verifier
    with _default_verifier_lock:
        _default_verifier = None
