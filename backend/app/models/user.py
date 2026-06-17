from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.types import TypeDecorator

from app.auth_database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator):
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("UTCDateTime values must be timezone-aware")
        return value.astimezone(timezone.utc)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid4()))
    clerk_user_id = Column(String(255), nullable=False, unique=True, index=True)
    username = Column(String(64), nullable=False, unique=True, index=True)
    email = Column(String(320), nullable=False, index=True)
    display_name = Column(String(255), nullable=True)
    avatar_url = Column(String(2048), nullable=True)
    role = Column(String(50), nullable=False, default="user", server_default="user")
    created_at = Column(UTCDateTime(), nullable=False, default=utc_now)
    updated_at = Column(UTCDateTime(), nullable=False, default=utc_now, onupdate=utc_now)
    guest_ids = relationship(
        "UserGuestId",
        back_populates="user",
        cascade="all, delete-orphan",
    )


class UserGuestId(Base):
    __tablename__ = "user_guest_ids"
    __table_args__ = (
        UniqueConstraint("guest_id", name="uq_user_guest_ids_guest_id"),
    )

    user_id = Column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    guest_id = Column(String(64), primary_key=True)
    linked_at = Column(UTCDateTime(), nullable=False, default=utc_now)

    user = relationship("User", back_populates="guest_ids")


class ClerkUserSyncState(Base):
    __tablename__ = "clerk_user_sync_states"

    clerk_user_key = Column(String(64), primary_key=True)
    last_event_at = Column(UTCDateTime(), nullable=False, default=utc_now)
    deleted_at = Column(UTCDateTime(), nullable=True)
