from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from app.config import settings


class SoloRoundTokenError(ValueError):
    pass


@dataclass(frozen=True)
class SoloRoundTokenPayload:
    player_id: int
    issued_at: datetime
    data_revision: str
    token_version: int = 1


def create_solo_round_token(
    *,
    player_id: int,
    data_revision: str,
    secret: str = settings.solo_round_token_secret,
    issued_at: datetime | None = None,
    token_version: int = 1,
) -> str:
    issued = issued_at or datetime.now(timezone.utc)
    payload = {
        "player_id": player_id,
        "issued_at": issued.isoformat(),
        "data_revision": data_revision,
        "token_version": token_version,
    }
    payload_bytes = _json_bytes(payload)
    encoded_payload = _b64encode(payload_bytes)
    signature = _signature(encoded_payload, secret)
    return f"{encoded_payload}.{signature}"


def validate_solo_round_token(
    token: str,
    *,
    current_data_revision: str,
    secret: str = settings.solo_round_token_secret,
    max_age: timedelta = timedelta(hours=1),
    expected_token_version: int = 1,
) -> SoloRoundTokenPayload:
    try:
        encoded_payload, supplied_signature = token.split(".", 1)
    except ValueError as exc:
        raise SoloRoundTokenError("Malformed solo round token") from exc

    expected_signature = _signature(encoded_payload, secret)
    if not hmac.compare_digest(supplied_signature, expected_signature):
        raise SoloRoundTokenError("Invalid solo round token signature")

    try:
        payload = json.loads(_b64decode(encoded_payload))
        issued_at = datetime.fromisoformat(payload["issued_at"])
        if issued_at.tzinfo is None:
            issued_at = issued_at.replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise SoloRoundTokenError("Invalid solo round token payload") from exc

    token_version = payload.get("token_version")
    if token_version != expected_token_version:
        raise SoloRoundTokenError("Unsupported solo round token version")
    data_revision = payload.get("data_revision")
    if data_revision != current_data_revision:
        raise SoloRoundTokenError("Stale solo round token")
    if datetime.now(timezone.utc) - issued_at > max_age:
        raise SoloRoundTokenError("Expired solo round token")

    player_id = payload.get("player_id")
    if not isinstance(player_id, int) or isinstance(player_id, bool) or player_id <= 0:
        raise SoloRoundTokenError("Invalid solo round token player")

    return SoloRoundTokenPayload(
        player_id=player_id,
        issued_at=issued_at,
        data_revision=data_revision,
        token_version=token_version,
    )


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _signature(encoded_payload: str, secret: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        encoded_payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return _b64encode(digest)


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> str:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii")).decode("utf-8")
