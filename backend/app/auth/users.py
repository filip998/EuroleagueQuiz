from __future__ import annotations

import hashlib
import re
from typing import Any, Mapping

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.user_sync_state import clerk_user_is_tombstoned
from app.models.user import User


class UserProvisioningError(ValueError):
    pass


class DeletedClerkUserError(UserProvisioningError):
    pass


def get_or_create_user_for_claims(db: Session, claims: Mapping[str, Any]) -> User:
    clerk_user_id = _validated_clerk_user_id(claims)
    _raise_if_clerk_user_is_tombstoned(db, clerk_user_id)
    existing = _find_by_clerk_user_id(db, clerk_user_id)
    if existing is not None:
        _raise_if_clerk_user_is_tombstoned(db, clerk_user_id)
        return existing

    user = _create_user_from_claims(db, clerk_user_id, claims)
    _raise_if_clerk_user_is_tombstoned(db, clerk_user_id)
    return user


def upsert_user_for_claims(
    db: Session,
    claims: Mapping[str, Any],
    *,
    commit: bool = True,
) -> User:
    clerk_user_id = _validated_clerk_user_id(claims)
    _raise_if_clerk_user_is_tombstoned(db, clerk_user_id)
    existing = _find_by_clerk_user_id(db, clerk_user_id)
    if existing is None:
        user = _create_user_from_claims(db, clerk_user_id, claims, commit=commit)
        if commit:
            _raise_if_clerk_user_is_tombstoned(db, clerk_user_id)
        return user

    user = _update_user_from_claims(db, existing, claims, commit=commit)
    if commit:
        _raise_if_clerk_user_is_tombstoned(db, clerk_user_id)
    return user


def delete_user_if_tombstoned(db: Session, clerk_user_id: str) -> bool:
    if not clerk_user_is_tombstoned(db, clerk_user_id):
        return False
    existing = _find_by_clerk_user_id(db, clerk_user_id)
    if existing is None:
        return False
    db.delete(existing)
    db.commit()
    return True


def _raise_if_clerk_user_is_tombstoned(db: Session, clerk_user_id: str) -> None:
    if delete_user_if_tombstoned(db, clerk_user_id) or clerk_user_is_tombstoned(db, clerk_user_id):
        raise DeletedClerkUserError("Clerk user has been deleted")


def _validated_clerk_user_id(claims: Mapping[str, Any]) -> str:
    clerk_user_id = claims.get("sub")
    if not isinstance(clerk_user_id, str) or not clerk_user_id or len(clerk_user_id) > 255:
        raise UserProvisioningError("Invalid Clerk user id")
    return clerk_user_id


def _create_user_from_claims(
    db: Session,
    clerk_user_id: str,
    claims: Mapping[str, Any],
    *,
    commit: bool = True,
) -> User:
    username = _claimed_username(claims)
    if username is None or _is_reserved_fallback_username(username):
        username = _fallback_username(clerk_user_id)
    if _username_is_taken(db, username):
        username = _fallback_username(clerk_user_id)

    return _insert_user(
        db,
        clerk_user_id=clerk_user_id,
        username=username,
        email=_claimed_email(claims) or _fallback_email(clerk_user_id),
        display_name=_claimed_display_name(claims),
        avatar_url=_claimed_avatar_url(claims),
        commit=commit,
    )


def _update_user_from_claims(
    db: Session,
    user: User,
    claims: Mapping[str, Any],
    *,
    commit: bool = True,
) -> User:
    clerk_user_id = user.clerk_user_id
    _assign_update_profile(db, user, claims)
    try:
        _flush_or_commit(db, commit=commit)
    except IntegrityError as exc:
        db.rollback()
        refreshed = _find_by_clerk_user_id(db, clerk_user_id)
        if refreshed is None:
            return _create_user_from_claims(db, clerk_user_id, claims, commit=commit)
        fallback_username = _next_available_fallback_username(
            db,
            refreshed.clerk_user_id,
            exclude_user_id=refreshed.id,
        )
        if fallback_username is None:
            raise UserProvisioningError("Could not provision Clerk user") from exc
        _assign_update_profile(db, refreshed, claims, username=fallback_username)
        try:
            _flush_or_commit(db, commit=commit)
        except IntegrityError as retry_exc:
            db.rollback()
            raise UserProvisioningError("Could not provision Clerk user") from retry_exc
        if commit:
            db.refresh(refreshed)
        return refreshed
    if commit:
        db.refresh(user)
    return user


def _assign_update_profile(
    db: Session,
    user: User,
    claims: Mapping[str, Any],
    *,
    username: str | None = None,
) -> None:
    user.username = username or _updated_username(db, user, claims)
    user.email = _claimed_email(claims) or user.email
    user.display_name = _claimed_display_name(claims)
    user.avatar_url = _claimed_avatar_url(claims)


def _updated_username(db: Session, user: User, claims: Mapping[str, Any]) -> str:
    username = _claimed_username(claims)
    if username is None:
        return user.username
    if _is_reserved_fallback_username(username) or _username_is_taken(
        db,
        username,
        exclude_user_id=user.id,
    ):
        fallback_username = _next_available_fallback_username(
            db,
            user.clerk_user_id,
            exclude_user_id=user.id,
        )
        if fallback_username is None:
            raise UserProvisioningError("Could not provision Clerk user")
        return fallback_username
    return username


def _insert_user(
    db: Session,
    *,
    clerk_user_id: str,
    username: str,
    email: str,
    display_name: str | None,
    avatar_url: str | None,
    commit: bool = True,
) -> User:
    user = User(
        clerk_user_id=clerk_user_id,
        username=username,
        email=email,
        display_name=display_name,
        avatar_url=avatar_url,
    )
    db.add(user)
    try:
        _flush_or_commit(db, commit=commit)
    except IntegrityError as exc:
        db.rollback()
        existing = _find_by_clerk_user_id(db, clerk_user_id)
        if existing is not None:
            return existing
        fallback_username = _next_available_fallback_username(db, clerk_user_id)
        if username != fallback_username and fallback_username is not None:
            return _insert_user(
                db,
                clerk_user_id=clerk_user_id,
                username=fallback_username,
                email=email,
                display_name=display_name,
                avatar_url=avatar_url,
                commit=commit,
            )
        raise UserProvisioningError("Could not provision Clerk user") from exc
    if commit:
        db.refresh(user)
    return user


def _flush_or_commit(db: Session, *, commit: bool) -> None:
    if commit:
        db.commit()
    else:
        db.flush()


def _find_by_clerk_user_id(db: Session, clerk_user_id: str) -> User | None:
    return db.execute(select(User).where(User.clerk_user_id == clerk_user_id)).scalar_one_or_none()


def _username_is_taken(db: Session, username: str, *, exclude_user_id: str | None = None) -> bool:
    statement = select(User.id).where(User.username == username)
    if exclude_user_id is not None:
        statement = statement.where(User.id != exclude_user_id)
    return db.execute(statement).first() is not None


def _claimed_username(claims: Mapping[str, Any]) -> str | None:
    for key in ("username", "preferred_username", "nickname"):
        value = _clean_username(claims.get(key))
        if value is not None:
            return value
    return None


def _claimed_email(claims: Mapping[str, Any]) -> str | None:
    email_addresses = claims.get("email_addresses")
    primary_email_address_id = claims.get("primary_email_address_id")
    if isinstance(email_addresses, list) and isinstance(primary_email_address_id, str):
        for item in email_addresses:
            if isinstance(item, Mapping) and item.get("id") == primary_email_address_id:
                value = _clean_email(item.get("email_address") or item.get("email"))
                if value is not None:
                    return value
    for key in ("email", "email_address", "primary_email_address"):
        value = _clean_email(claims.get(key))
        if value is not None:
            return value
    if isinstance(email_addresses, list):
        for item in email_addresses:
            if isinstance(item, Mapping):
                value = _clean_email(item.get("email_address") or item.get("email"))
                if value is not None:
                    return value
    return None


def _claimed_display_name(claims: Mapping[str, Any]) -> str | None:
    for key in ("name", "display_name", "full_name"):
        value = _clean_string(claims.get(key), max_length=255)
        if value is not None:
            return value
    first_name = _clean_string(claims.get("first_name"), max_length=120)
    last_name = _clean_string(claims.get("last_name"), max_length=120)
    if first_name and last_name:
        return f"{first_name} {last_name}"[:255]
    return first_name or last_name


def _claimed_avatar_url(claims: Mapping[str, Any]) -> str | None:
    for key in ("image_url", "avatar_url", "picture"):
        value = _clean_string(claims.get(key), max_length=2048)
        if value is not None:
            return value
    return None


def _clean_username(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip()).strip("._-")
    if not cleaned:
        return None
    return cleaned[:64]


def _clean_email(value: Any) -> str | None:
    cleaned = _clean_string(value, max_length=320)
    if cleaned is None or "@" not in cleaned:
        return None
    return cleaned.lower()


def _clean_string(value: Any, *, max_length: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    return cleaned[:max_length]


def _fallback_username(clerk_user_id: str) -> str:
    return f"user_{_subject_digest(clerk_user_id)}"


def _fallback_username_with_suffix(clerk_user_id: str, suffix: int) -> str:
    base = _fallback_username(clerk_user_id)
    return f"{base}_{suffix}"[:64]


def _next_available_fallback_username(
    db: Session,
    clerk_user_id: str,
    *,
    exclude_user_id: str | None = None,
) -> str | None:
    for suffix in range(0, 100):
        username = (
            _fallback_username(clerk_user_id)
            if suffix == 0
            else _fallback_username_with_suffix(clerk_user_id, suffix)
        )
        if not _username_is_taken(db, username, exclude_user_id=exclude_user_id):
            return username
    return None


def _is_reserved_fallback_username(username: str) -> bool:
    return re.fullmatch(r"user_[0-9a-f]{16}(?:_[0-9]{1,2})?", username) is not None


def _fallback_email(clerk_user_id: str) -> str:
    return f"{_fallback_username(clerk_user_id)}@clerk.invalid"


def _subject_digest(clerk_user_id: str) -> str:
    return hashlib.sha256(clerk_user_id.encode("utf-8")).hexdigest()[:16]
