from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.user import User, UserGuestId

GUEST_ID_MAX_LENGTH = 64


class GuestIdValidationError(ValueError):
    pass


class GuestIdConflictError(ValueError):
    pass


@dataclass(frozen=True)
class GuestLinkResult:
    guest_id: str
    status: Literal["linked", "already_linked"]


def link_guest_id(db: Session, user: User, guest_id: str | None) -> GuestLinkResult:
    cleaned_guest_id = clean_guest_id(guest_id)
    existing = _find_guest_link(db, cleaned_guest_id)
    if existing is not None:
        return _result_for_existing_link(existing, user)

    link = UserGuestId(user_id=user.id, guest_id=cleaned_guest_id)
    db.add(link)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        existing = _find_guest_link(db, cleaned_guest_id)
        if existing is not None:
            return _result_for_existing_link(existing, user, conflict_cause=exc)
        raise
    return GuestLinkResult(guest_id=cleaned_guest_id, status="linked")


def clean_guest_id(guest_id: str | None) -> str:
    if guest_id is None:
        raise GuestIdValidationError("guest_id is required")
    cleaned = guest_id.strip()[:GUEST_ID_MAX_LENGTH]
    if not cleaned:
        raise GuestIdValidationError("guest_id is required")
    return cleaned


def _find_guest_link(db: Session, guest_id: str) -> UserGuestId | None:
    return db.execute(
        select(UserGuestId).where(UserGuestId.guest_id == guest_id)
    ).scalar_one_or_none()


def _result_for_existing_link(
    link: UserGuestId,
    user: User,
    *,
    conflict_cause: Exception | None = None,
) -> GuestLinkResult:
    if link.user_id == user.id:
        return GuestLinkResult(guest_id=link.guest_id, status="already_linked")
    raise GuestIdConflictError("guest_id is already linked to another user") from conflict_cause
