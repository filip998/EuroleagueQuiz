from __future__ import annotations

import hashlib

from sqlalchemy.orm import Session

from app.models.user import ClerkUserSyncState


def clerk_user_sync_key(clerk_user_id: str) -> str:
    return hashlib.sha256(clerk_user_id.encode("utf-8")).hexdigest()


def find_clerk_user_sync_state(
    db: Session,
    clerk_user_id: str,
) -> ClerkUserSyncState | None:
    return db.get(ClerkUserSyncState, clerk_user_sync_key(clerk_user_id))


def clerk_user_is_tombstoned(db: Session, clerk_user_id: str) -> bool:
    state = find_clerk_user_sync_state(db, clerk_user_id)
    return state is not None and state.deleted_at is not None
