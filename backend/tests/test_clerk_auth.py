from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import threading
from typing import Any, Mapping

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.testclient import TestClient
import jwt
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

import app.auth.clerk as clerk_module
import app.auth.dependencies as auth_dependencies
import app.auth.users as users_module
from app.auth.clerk import ClerkAuthConfigurationError, ClerkJWTVerifier, ClerkTokenError, JWKSCache
from app.auth.users import get_or_create_user_for_claims
from app.auth_database import Base, get_auth_db, sqlite_connect_args
from app.main import app
from app.models.user import User

ISSUER = "https://test-instance.clerk.accounts.dev"
JWKS_URL = f"{ISSUER}/.well-known/jwks.json"


@dataclass(frozen=True)
class SigningKey:
    kid: str
    private_key: rsa.RSAPrivateKey
    jwk: dict[str, str]


@pytest.fixture
def signing_key() -> SigningKey:
    return _new_signing_key("test-key")


@pytest.fixture
def auth_session_factory(tmp_path):
    database_url = f"sqlite:///{tmp_path / 'users.db'}"
    engine = create_engine(database_url, connect_args=sqlite_connect_args(database_url))
    Base.metadata.create_all(bind=engine)
    try:
        yield sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)
    finally:
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def test_verifier_accepts_valid_token_and_caches_jwks(signing_key):
    fetches: list[str] = []
    verifier = _verifier(signing_key.jwk, fetches=fetches)
    token = _make_token(signing_key)

    claims = verifier.verify(token)
    verifier.verify(token)

    assert claims["sub"] == "user_clerk_123"
    assert fetches == [JWKS_URL]


@pytest.mark.parametrize(
    "token_builder",
    [
        lambda key: _make_token(key, expires_delta=timedelta(seconds=-1)),
        lambda key: _make_token(key, issuer="https://evil.example.com"),
        lambda key: _make_token(key, include_exp=False),
        lambda key: _make_token(_new_signing_key("test-key")),
    ],
)
def test_verifier_rejects_expired_wrong_issuer_missing_exp_and_forged_tokens(signing_key, token_builder):
    verifier = _verifier(signing_key.jwk)

    with pytest.raises(ClerkTokenError):
        verifier.verify(token_builder(signing_key))


def test_verifier_rejects_alg_confusion_tokens(signing_key):
    verifier = _verifier(signing_key.jwk)
    hs256_token = _make_token(signing_key, algorithm="HS256", key="not-the-rsa-key")
    none_token = _make_token(signing_key, algorithm="none", key="")

    with pytest.raises(ClerkTokenError):
        verifier.verify(hs256_token)
    with pytest.raises(ClerkTokenError):
        verifier.verify(none_token)


def test_verifier_wraps_malformed_jwks_key_errors(signing_key):
    malformed_jwk = {
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "kid": signing_key.kid,
    }
    verifier = _verifier(malformed_jwk)

    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(signing_key))


def test_verifier_validates_authorized_party_when_present(signing_key):
    verifier = _verifier(signing_key.jwk, authorized_parties=("https://app.example.com",))

    verifier.verify(_make_token(signing_key, claims={"azp": "https://app.example.com"}))

    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(signing_key))
    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(signing_key, claims={"azp": "https://evil.example.com"}))


def test_jwks_cache_refreshes_once_for_rotated_key():
    old_key = _new_signing_key("old-key")
    new_key = _new_signing_key("new-key")
    responses: list[Mapping[str, Any]] = [
        {"keys": [old_key.jwk]},
        {"keys": [old_key.jwk, new_key.jwk]},
    ]
    fetches: list[str] = []

    def fetcher(url: str) -> Mapping[str, Any]:
        fetches.append(url)
        return responses[min(len(fetches) - 1, len(responses) - 1)]

    verifier = _verifier(old_key.jwk, fetcher=fetcher)

    verifier.verify(_make_token(old_key))
    verifier.verify(_make_token(new_key))

    assert fetches == [JWKS_URL, JWKS_URL]


def test_jwks_cache_waits_for_in_flight_rotation_refresh():
    old_key = _new_signing_key("old-key")
    new_key = _new_signing_key("new-key")
    fetches: list[str] = []
    refresh_started = threading.Event()
    release_refresh = threading.Event()

    def fetcher(url: str) -> Mapping[str, Any]:
        fetches.append(url)
        if len(fetches) == 1:
            return {"keys": [old_key.jwk]}
        refresh_started.set()
        assert release_refresh.wait(timeout=2.0)
        return {"keys": [old_key.jwk, new_key.jwk]}

    verifier = _verifier(old_key.jwk, fetcher=fetcher)
    verifier.verify(_make_token(old_key))

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(verifier.verify, _make_token(new_key))
        assert refresh_started.wait(timeout=2.0)
        second = executor.submit(verifier.verify, _make_token(new_key))
        release_refresh.set()

        assert first.result(timeout=2.0)["sub"] == "user_clerk_123"
        assert second.result(timeout=2.0)["sub"] == "user_clerk_123"

    assert fetches == [JWKS_URL, JWKS_URL]


def test_jwks_cache_allows_rotated_kid_after_multiple_unknown_kids():
    old_key = _new_signing_key("old-key")
    new_key = _new_signing_key("new-key")
    responses: list[Mapping[str, Any]] = [
        {"keys": [old_key.jwk]},
        {"keys": [old_key.jwk]},
        {"keys": [old_key.jwk, new_key.jwk]},
    ]
    fetches: list[str] = []
    now = 0.0

    def fetcher(url: str) -> Mapping[str, Any]:
        fetches.append(url)
        return responses[min(len(fetches) - 1, len(responses) - 1)]

    def clock() -> float:
        return now

    verifier = _verifier(old_key.jwk, fetcher=fetcher, clock=clock)

    verifier.verify(_make_token(old_key))
    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(old_key, kid="random-unknown-one"))
    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(old_key, kid="random-unknown-two"))
    now += 1.1
    verifier.verify(_make_token(new_key))

    assert fetches == [JWKS_URL, JWKS_URL, JWKS_URL]


def test_jwks_cache_rate_limits_unknown_kid_refreshes(signing_key):
    fetches: list[str] = []
    now = 0.0

    def clock() -> float:
        return now

    verifier = _verifier(signing_key.jwk, fetches=fetches, clock=clock)

    verifier.verify(_make_token(signing_key))
    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(signing_key, kid="unknown-one"))
    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(signing_key, kid="unknown-one"))
    for suffix in range(2, 10):
        with pytest.raises(ClerkTokenError):
            verifier.verify(_make_token(signing_key, kid=f"unknown-{suffix}"))

    assert fetches == [JWKS_URL, JWKS_URL]

    now += 1.1
    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(signing_key, kid="unknown-two"))

    assert fetches == [JWKS_URL, JWKS_URL, JWKS_URL]


def test_jwks_cache_rate_limits_failed_unknown_kid_refreshes(signing_key):
    fetches: list[str] = []
    now = 0.0

    def fetcher(url: str) -> Mapping[str, Any]:
        fetches.append(url)
        if len(fetches) == 1:
            return {"keys": [signing_key.jwk]}
        raise ClerkTokenError("JWKS unavailable")

    def clock() -> float:
        return now

    verifier = _verifier(signing_key.jwk, fetcher=fetcher, clock=clock)

    verifier.verify(_make_token(signing_key))
    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(signing_key, kid="unknown-one"))
    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(signing_key, kid="unknown-one"))
    for suffix in range(2, 10):
        with pytest.raises(ClerkTokenError):
            verifier.verify(_make_token(signing_key, kid=f"unknown-{suffix}"))

    assert fetches == [JWKS_URL, JWKS_URL]

    now += 1.1
    with pytest.raises(ClerkTokenError):
        verifier.verify(_make_token(signing_key, kid="unknown-two"))

    assert fetches == [JWKS_URL, JWKS_URL, JWKS_URL]


def test_jwks_cache_fetches_without_holding_lock(signing_key):
    fetches: list[str] = []
    fetch_started = threading.Event()
    release_fetch = threading.Event()

    def fetcher(url: str) -> Mapping[str, Any]:
        fetches.append(url)
        fetch_started.set()
        assert release_fetch.wait(timeout=2.0)
        return {"keys": [signing_key.jwk]}

    cache = JWKSCache(fetcher=fetcher, ttl_seconds=300.0, refresh_cooldown_seconds=30.0)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(cache.get_key, JWKS_URL, signing_key.kid)
        assert fetch_started.wait(timeout=2.0)
        assert cache._lock.acquire(blocking=False)
        cache._lock.release()
        release_fetch.set()
        assert future.result(timeout=2.0) == signing_key.jwk
    assert fetches == [JWKS_URL]


def test_default_verifier_initializes_once_under_concurrent_cold_start(monkeypatch, signing_key):
    clerk_module.reset_clerk_jwt_verifier()
    build_count = 0
    build_started = threading.Event()
    release_build = threading.Event()
    verifier = _verifier(signing_key.jwk)

    def build_verifier():
        nonlocal build_count
        build_count += 1
        build_started.set()
        assert release_build.wait(timeout=2.0)
        return verifier

    monkeypatch.setattr(ClerkJWTVerifier, "from_settings", staticmethod(build_verifier))
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(clerk_module.get_clerk_jwt_verifier)
            assert build_started.wait(timeout=2.0)
            second = executor.submit(clerk_module.get_clerk_jwt_verifier)
            release_build.set()

            assert first.result(timeout=2.0) is verifier
            assert second.result(timeout=2.0) is verifier
        assert build_count == 1
    finally:
        clerk_module.reset_clerk_jwt_verifier()


def test_get_current_user_401s_and_jit_provisions(monkeypatch, auth_session_factory, signing_key):
    verifier = _verifier(signing_key.jwk)
    monkeypatch.setattr(auth_dependencies, "get_clerk_jwt_verifier", lambda: verifier)

    with auth_session_factory() as db:
        for authorization in (
            None,
            f"Bearer {_make_token(signing_key, expires_delta=timedelta(seconds=-1))}",
            f"Bearer {_make_token(signing_key, issuer='https://evil.example.com')}",
        ):
            with pytest.raises(HTTPException) as exc_info:
                auth_dependencies.get_current_user(authorization=authorization, db=db)
            assert exc_info.value.status_code == 401

        user = auth_dependencies.get_current_user(
            authorization=f"Bearer {_make_token(signing_key)}",
            db=db,
        )

        assert user.clerk_user_id == "user_clerk_123"
        assert user.username.startswith("user_")
        assert user.email.endswith("@clerk.invalid")


def test_auth_dependencies_do_not_swallow_configuration_errors(monkeypatch, auth_session_factory):
    def raise_configuration_error():
        raise ClerkAuthConfigurationError("missing Clerk config")

    monkeypatch.setattr(auth_dependencies, "get_clerk_jwt_verifier", raise_configuration_error)

    with auth_session_factory() as db:
        with pytest.raises(ClerkAuthConfigurationError):
            auth_dependencies.get_current_user(authorization="Bearer token", db=db)
        with pytest.raises(ClerkAuthConfigurationError):
            auth_dependencies.get_optional_user(authorization="Bearer token", db=db)


def test_auth_dependencies_do_not_treat_provisioning_errors_as_invalid_tokens(
    monkeypatch,
    auth_session_factory,
    signing_key,
):
    verifier = _verifier(signing_key.jwk)

    def raise_provisioning_error(db, claims):
        raise auth_dependencies.UserProvisioningError("could not provision")

    monkeypatch.setattr(auth_dependencies, "get_clerk_jwt_verifier", lambda: verifier)
    monkeypatch.setattr(auth_dependencies, "get_or_create_user_for_claims", raise_provisioning_error)

    with auth_session_factory() as db:
        authorization = f"Bearer {_make_token(signing_key)}"
        with pytest.raises(HTTPException) as exc_info:
            auth_dependencies.get_current_user(authorization=authorization, db=db)
        assert exc_info.value.status_code == 500
        assert exc_info.value.headers is None

        with pytest.raises(auth_dependencies.UserProvisioningError):
            auth_dependencies.get_optional_user(authorization=authorization, db=db)


def test_get_optional_user_returns_none_for_missing_and_invalid_tokens(
    monkeypatch,
    auth_session_factory,
    signing_key,
):
    verifier = _verifier(signing_key.jwk)
    monkeypatch.setattr(auth_dependencies, "get_clerk_jwt_verifier", lambda: verifier)

    with auth_session_factory() as db:
        assert auth_dependencies.get_optional_user(authorization=None, db=db) is None
        assert auth_dependencies.get_optional_user(authorization="Bearer not-a-jwt", db=db) is None
        assert (
            auth_dependencies.get_optional_user(
                authorization=f"Bearer {_make_token(signing_key, issuer='https://evil.example.com')}",
                db=db,
            )
            is None
        )


def test_jit_provisioning_is_idempotent_with_minimal_claims(auth_session_factory):
    with auth_session_factory() as db:
        first = get_or_create_user_for_claims(db, {"sub": "user_clerk_minimal"})
        second = get_or_create_user_for_claims(db, {"sub": "user_clerk_minimal"})
        count = db.scalar(select(func.count()).select_from(User))

        assert second.id == first.id
        assert count == 1
        assert first.username.startswith("user_")
        assert first.email.endswith("@clerk.invalid")


def test_jit_provisioning_returns_existing_user_after_clerk_id_race(
    monkeypatch,
    auth_session_factory,
):
    with auth_session_factory() as db:
        existing = User(
            clerk_user_id="user_race",
            username="winner",
            email="winner@example.com",
        )
        db.add(existing)
        db.commit()
        db.refresh(existing)

        original_find = users_module._find_by_clerk_user_id
        first_lookup = True

        def simulate_concurrent_insert(db_arg, clerk_user_id):
            nonlocal first_lookup
            if first_lookup:
                first_lookup = False
                return None
            return original_find(db_arg, clerk_user_id)

        monkeypatch.setattr(users_module, "_find_by_clerk_user_id", simulate_concurrent_insert)

        user = get_or_create_user_for_claims(
            db,
            {
                "sub": "user_race",
                "username": "loser",
                "email": "loser@example.com",
            },
        )
        count = db.scalar(select(func.count()).select_from(User))

        assert user.id == existing.id
        assert count == 1


def test_jit_provisioning_handles_username_collision(auth_session_factory):
    with auth_session_factory() as db:
        db.add(
            User(
                clerk_user_id="user_existing",
                username="filip",
                email="filip@example.com",
            )
        )
        db.commit()

        user = get_or_create_user_for_claims(
            db,
            {
                "sub": "user_new",
                "username": "filip",
                "email": "new@example.com",
                "name": "New User",
                "image_url": "https://example.com/avatar.png",
            },
        )

        assert user.username != "filip"
        assert user.username.startswith("user_")
        assert user.email == "new@example.com"
        assert user.display_name == "New User"
        assert user.avatar_url == "https://example.com/avatar.png"


def test_jit_provisioning_retries_when_fallback_username_is_taken(auth_session_factory):
    with auth_session_factory() as db:
        fallback_username = "user_76ece34db34813ba"
        db.add(
            User(
                clerk_user_id="user_existing",
                username=fallback_username,
                email="existing@example.com",
            )
        )
        db.commit()

        user = get_or_create_user_for_claims(db, {"sub": "user_new"})

        assert user.username == f"{fallback_username}_1"
        assert user.email.endswith("@clerk.invalid")


def test_jit_provisioning_does_not_allow_claimed_fallback_namespace(auth_session_factory):
    with auth_session_factory() as db:
        user = get_or_create_user_for_claims(
            db,
            {
                "sub": "user_new",
                "username": "user_0123456789abcdef",
                "email": "new@example.com",
            },
        )

        assert user.username != "user_0123456789abcdef"
        assert user.username.startswith("user_")
        assert user.email == "new@example.com"


def test_auth_me_requires_token_and_returns_provisioned_user(
    monkeypatch,
    auth_session_factory,
    signing_key,
):
    verifier = _verifier(signing_key.jwk)
    monkeypatch.setattr(auth_dependencies, "get_clerk_jwt_verifier", lambda: verifier)
    previous_override = app.dependency_overrides.get(get_auth_db)

    def override_get_auth_db():
        db = auth_session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_auth_db] = override_get_auth_db
    try:
        client = TestClient(app)
        missing = client.get("/auth/me")
        valid = client.get("/auth/me", headers={"Authorization": f"Bearer {_make_token(signing_key)}"})
    finally:
        if previous_override is None:
            app.dependency_overrides.pop(get_auth_db, None)
        else:
            app.dependency_overrides[get_auth_db] = previous_override

    assert missing.status_code == 401
    assert valid.status_code == 200
    body = valid.json()
    assert body["username"].startswith("user_")
    assert body["email"].endswith("@clerk.invalid")
    assert "clerk_user_id" not in body


def _verifier(
    jwk: Mapping[str, Any],
    *,
    fetches: list[str] | None = None,
    fetcher=None,
    authorized_parties: tuple[str, ...] = (),
    clock=None,
    unknown_kid_min_refresh_interval_seconds: float = 1.0,
) -> ClerkJWTVerifier:
    if fetcher is None:

        def fetcher(url: str) -> Mapping[str, Any]:
            if fetches is not None:
                fetches.append(url)
            return {"keys": [jwk]}

    return ClerkJWTVerifier(
        issuer=ISSUER,
        jwks_url=JWKS_URL,
        authorized_parties=authorized_parties,
        leeway_seconds=0,
        jwks_cache=JWKSCache(
            fetcher=fetcher,
            ttl_seconds=300.0,
            refresh_cooldown_seconds=30.0,
            unknown_kid_min_refresh_interval_seconds=unknown_kid_min_refresh_interval_seconds,
            **({"clock": clock} if clock is not None else {}),
        ),
    )


def _new_signing_key(kid: str) -> SigningKey:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_numbers = private_key.public_key().public_numbers()
    jwk = {
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "kid": kid,
        "n": _b64url_uint(public_numbers.n),
        "e": _b64url_uint(public_numbers.e),
    }
    return SigningKey(kid=kid, private_key=private_key, jwk=jwk)


def _make_token(
    signing_key: SigningKey,
    *,
    issuer: str = ISSUER,
    subject: str = "user_clerk_123",
    expires_delta: timedelta = timedelta(minutes=5),
    include_exp: bool = True,
    claims: Mapping[str, Any] | None = None,
    algorithm: str = "RS256",
    key: Any = None,
    kid: str | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "iss": issuer,
        "sub": subject,
        "iat": now,
        "nbf": now - timedelta(seconds=1),
    }
    if include_exp:
        payload["exp"] = now + expires_delta
    if claims:
        payload.update(claims)

    return jwt.encode(
        payload,
        signing_key.private_key if key is None else key,
        algorithm=algorithm,
        headers={"kid": kid or signing_key.kid},
    )


def _b64url_uint(value: int) -> str:
    byte_length = (value.bit_length() + 7) // 8
    encoded = base64.urlsafe_b64encode(value.to_bytes(byte_length, "big"))
    return encoded.rstrip(b"=").decode("ascii")
