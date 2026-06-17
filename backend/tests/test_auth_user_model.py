from datetime import timezone
import time
from uuid import UUID

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.auth_database import Base, sqlite_connect_args
from app.models.user import User


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


def test_user_create_round_trip_defaults_and_updated_at(auth_session_factory):
    with auth_session_factory() as db:
        user = User(
            clerk_user_id="user_clerk_123",
            username="filip",
            email="filip@example.com",
            display_name="Filip",
            avatar_url=None,
        )
        db.add(user)
        db.flush()

        user_id = user.id
        assert str(UUID(user_id)) == user_id
        assert user.role == "user"
        assert user.created_at.tzinfo is timezone.utc
        assert user.updated_at.tzinfo is timezone.utc
        assert user.updated_at >= user.created_at
        db.commit()

    with auth_session_factory() as db:
        stored = db.get(User, user_id)
        assert stored is not None
        assert stored.clerk_user_id == "user_clerk_123"
        assert stored.username == "filip"
        assert stored.email == "filip@example.com"
        assert stored.display_name == "Filip"
        assert stored.avatar_url is None
        assert stored.role == "user"
        assert stored.created_at.tzinfo is timezone.utc
        assert stored.updated_at.tzinfo is timezone.utc

        original_updated_at = stored.updated_at
        time.sleep(0.001)
        stored.display_name = "Filip Tanic"
        db.flush()

        assert stored.updated_at.tzinfo is timezone.utc
        assert stored.updated_at > original_updated_at


def test_user_clerk_user_id_and_username_are_unique(auth_session_factory):
    with auth_session_factory() as db:
        db.add(
            User(
                clerk_user_id="user_clerk_123",
                username="filip",
                email="filip@example.com",
            )
        )
        db.commit()

        db.add(
            User(
                clerk_user_id="user_clerk_123",
                username="filip2",
                email="filip2@example.com",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()

        db.add(
            User(
                clerk_user_id="user_clerk_456",
                username="filip",
                email="filip3@example.com",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()
