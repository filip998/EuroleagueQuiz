from __future__ import annotations

from binascii import Error as BinasciiError
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Mapping

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from svix.webhooks import Webhook, WebhookVerificationError

from app.auth.user_sync_state import clerk_user_sync_key, find_clerk_user_sync_state
from app.auth.users import delete_user_if_tombstoned, upsert_user_for_claims
from app.config import settings
from app.models.user import ClerkUserSyncState, User, utc_now


class ClerkWebhookConfigurationError(RuntimeError):
    pass


class ClerkWebhookVerificationError(ValueError):
    pass


class ClerkWebhookPayloadError(ValueError):
    pass


@dataclass(frozen=True)
class ClerkWebhookResult:
    event_type: str
    status: Literal["processed", "ignored"]


def handle_clerk_webhook(
    raw_body: bytes,
    headers: Mapping[str, str],
    db: Session,
) -> ClerkWebhookResult:
    event = _verify_event(raw_body, headers)
    event_type = event.get("type")
    if not isinstance(event_type, str) or not event_type:
        raise ClerkWebhookPayloadError("Clerk webhook event type is required")

    if event_type in {"user.created", "user.updated"}:
        claims = _claims_from_user_data(event.get("data"))
        clerk_user_id = claims["sub"]
        event_time = _event_time_for_ordering(_event_timestamp(event))
        if not _claim_mutation_state(db, clerk_user_id, event_time):
            delete_user_if_tombstoned(db, clerk_user_id)
            return ClerkWebhookResult(event_type=event_type, status="processed")
        upsert_user_for_claims(db, claims, commit=False)
        if not _ensure_mutation_state_recorded(db, clerk_user_id, event_time):
            db.rollback()
            delete_user_if_tombstoned(db, clerk_user_id)
            return ClerkWebhookResult(event_type=event_type, status="processed")
        db.commit()
        delete_user_if_tombstoned(db, clerk_user_id)
        return ClerkWebhookResult(event_type=event_type, status="processed")

    if event_type == "user.deleted":
        clerk_user_id = _clerk_user_id_from_data(event.get("data"))
        event_time = _event_time_for_ordering(_event_timestamp(event))
        _record_delete_state(db, clerk_user_id, event_time)
        user = db.execute(select(User).where(User.clerk_user_id == clerk_user_id)).scalar_one_or_none()
        if user is not None:
            db.delete(user)
            db.commit()
        else:
            db.commit()
        delete_user_if_tombstoned(db, clerk_user_id)
        return ClerkWebhookResult(event_type=event_type, status="processed")

    return ClerkWebhookResult(event_type=event_type, status="ignored")


def _verify_event(raw_body: bytes, headers: Mapping[str, str]) -> Mapping[str, Any]:
    secret = settings.clerk_webhook_secret
    if secret is None or not secret.strip():
        raise ClerkWebhookConfigurationError("ELQ_CLERK_WEBHOOK_SECRET is not configured")
    try:
        event = Webhook(secret).verify(raw_body, headers)
    except (WebhookVerificationError, BinasciiError, ValueError) as exc:
        raise ClerkWebhookVerificationError("Invalid Clerk webhook signature") from exc
    if not isinstance(event, Mapping):
        raise ClerkWebhookPayloadError("Clerk webhook payload must be an object")
    return event


def _claims_from_user_data(data: Any) -> dict[str, Any]:
    if not isinstance(data, Mapping):
        raise ClerkWebhookPayloadError("Clerk webhook user data must be an object")
    clerk_user_id = _clerk_user_id_from_data(data)
    return {**data, "sub": clerk_user_id}


def _clerk_user_id_from_data(data: Any) -> str:
    if not isinstance(data, Mapping):
        raise ClerkWebhookPayloadError("Clerk webhook user data must be an object")
    clerk_user_id = data.get("id")
    if not isinstance(clerk_user_id, str) or not clerk_user_id or len(clerk_user_id) > 255:
        raise ClerkWebhookPayloadError("Clerk webhook user id is required")
    return clerk_user_id


def _find_sync_state(db: Session, clerk_user_id: str) -> ClerkUserSyncState | None:
    return find_clerk_user_sync_state(db, clerk_user_id)


def _claim_mutation_state(
    db: Session,
    clerk_user_id: str,
    event_time: datetime,
) -> bool:
    clerk_user_key = clerk_user_sync_key(clerk_user_id)
    result = db.execute(
        update(ClerkUserSyncState)
        .where(ClerkUserSyncState.clerk_user_key == clerk_user_key)
        .where(ClerkUserSyncState.deleted_at.is_(None))
        .where(ClerkUserSyncState.last_event_at < event_time)
        .values(last_event_at=event_time)
    )
    if result.rowcount == 1:
        return True

    state = _find_sync_state(db, clerk_user_id)
    if state is None:
        state = ClerkUserSyncState(
            clerk_user_key=clerk_user_key,
            last_event_at=event_time,
        )
        db.add(state)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            return _claim_mutation_state(db, clerk_user_id, event_time)
        return True
    return False


def _ensure_mutation_state_recorded(
    db: Session,
    clerk_user_id: str,
    event_time: datetime,
) -> bool:
    state = _find_sync_state(db, clerk_user_id)
    if state is not None:
        if state.deleted_at is not None:
            return False
        if state.last_event_at == event_time:
            return True
        if state.last_event_at > event_time:
            return False
    return _claim_mutation_state(db, clerk_user_id, event_time)


def _record_delete_state(
    db: Session,
    clerk_user_id: str,
    event_time: datetime,
) -> None:
    state = _find_sync_state(db, clerk_user_id)
    if state is None:
        state = ClerkUserSyncState(
            clerk_user_key=clerk_user_sync_key(clerk_user_id),
            last_event_at=event_time,
        )
        db.add(state)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            _record_delete_state(db, clerk_user_id, event_time)
        else:
            state.deleted_at = event_time
        return
    else:
        state.last_event_at = max(state.last_event_at, event_time)
        state.deleted_at = event_time


def _event_time_for_ordering(event_at: datetime | None) -> datetime:
    return event_at or utc_now()


def _event_timestamp(event: Mapping[str, Any]) -> datetime | None:
    value = event.get("timestamp")
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return _timestamp_from_number(float(value))
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        if stripped.isdigit():
            return _timestamp_from_number(float(stripped))
        try:
            parsed = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    return None


def _timestamp_from_number(value: float) -> datetime | None:
    if value <= 0:
        return None
    seconds = value / 1000 if value > 10_000_000_000 else value
    return datetime.fromtimestamp(seconds, timezone.utc)
