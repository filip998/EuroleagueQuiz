from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


class SoloRoundTokenError(ValueError):
    pass


@dataclass(frozen=True)
class SoloRoundTokenPayload:
    player_id: int
    issued_at: datetime
    data_revision: str
    token_version: int = 2


def create_solo_round_token(
    *,
    player_id: int,
    data_revision: str,
    secret: str = settings.solo_round_token_secret,
    issued_at: datetime | None = None,
    token_version: int = 2,
) -> str:
    issued = issued_at or datetime.now(timezone.utc)
    payload = {
        "player_id": player_id,
        "issued_at": issued.isoformat(),
        "data_revision": data_revision,
        "token_version": token_version,
    }
    return _fernet(secret).encrypt(_json_bytes(payload)).decode("ascii")


def validate_solo_round_token(
    token: str,
    *,
    current_data_revision: str,
    secret: str = settings.solo_round_token_secret,
    max_age: timedelta = timedelta(hours=1),
    expected_token_version: int = 2,
) -> SoloRoundTokenPayload:
    try:
        payload_bytes = _fernet(secret).decrypt(token.encode("ascii"))
        payload = json.loads(payload_bytes)
        issued_at = datetime.fromisoformat(payload["issued_at"])
        if issued_at.tzinfo is None:
            issued_at = issued_at.replace(tzinfo=timezone.utc)
    except (InvalidToken, UnicodeEncodeError) as exc:
        raise SoloRoundTokenError("Invalid solo round token") from exc
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


def _fernet(secret: str) -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)
