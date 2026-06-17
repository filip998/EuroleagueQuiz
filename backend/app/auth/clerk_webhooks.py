from __future__ import annotations

from binascii import Error as BinasciiError
from dataclasses import dataclass
from typing import Any, Literal, Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session
from svix.webhooks import Webhook, WebhookVerificationError

from app.auth.users import upsert_user_for_claims
from app.config import settings
from app.models.user import User


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
        upsert_user_for_claims(db, claims)
        return ClerkWebhookResult(event_type=event_type, status="processed")

    if event_type == "user.deleted":
        clerk_user_id = _clerk_user_id_from_data(event.get("data"))
        user = db.execute(select(User).where(User.clerk_user_id == clerk_user_id)).scalar_one_or_none()
        if user is not None:
            db.delete(user)
            db.commit()
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
