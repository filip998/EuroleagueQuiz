from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Mapping

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

import app.auth.clerk_webhooks as clerk_webhooks
from app.auth.guest_links import link_guest_id
from app.auth_database import Base, get_auth_db, sqlite_connect_args
from app.main import app
from app.models.user import User, UserGuestId

WEBHOOK_SECRET_BYTES = b"test-clerk-webhook-secret"
WEBHOOK_SECRET = f"whsec_{base64.b64encode(WEBHOOK_SECRET_BYTES).decode()}"


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


@pytest.fixture
def auth_client(auth_session_factory, monkeypatch):
    monkeypatch.setattr(clerk_webhooks.settings, "clerk_webhook_secret", WEBHOOK_SECRET)
    previous_override = app.dependency_overrides.get(get_auth_db)

    def override_get_auth_db():
        db = auth_session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_auth_db] = override_get_auth_db
    try:
        with TestClient(app) as client:
            yield client
    finally:
        if previous_override is None:
            app.dependency_overrides.pop(get_auth_db, None)
        else:
            app.dependency_overrides[get_auth_db] = previous_override


def test_clerk_webhook_rejects_missing_secret(auth_client, auth_session_factory, monkeypatch):
    monkeypatch.setattr(clerk_webhooks.settings, "clerk_webhook_secret", None)

    response = _post_signed(auth_client, _user_event("user.created"))

    assert response.status_code == 503
    assert response.json() == {"detail": "Clerk webhook is not configured"}
    with auth_session_factory() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0


def test_clerk_webhook_rejects_missing_signature(auth_client, auth_session_factory):
    body = _event_body(_user_event("user.created"))

    response = auth_client.post(
        "/auth/webhooks/clerk",
        content=body,
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid Clerk webhook signature"}
    with auth_session_factory() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0


def test_clerk_webhook_rejects_invalid_signature(auth_client, auth_session_factory):
    body, headers = _signed_request(_user_event("user.created"))
    headers["svix-signature"] = "v1,invalid"

    response = auth_client.post("/auth/webhooks/clerk", content=body, headers=headers)

    assert response.status_code == 400
    assert response.json() == {"detail": "Invalid Clerk webhook signature"}
    with auth_session_factory() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0


def test_clerk_webhook_rejects_stale_signed_timestamp(auth_client, auth_session_factory):
    response = _post_signed(
        auth_client,
        _user_event("user.created"),
        timestamp=int(time.time()) - 10 * 60,
    )

    assert response.status_code == 400
    with auth_session_factory() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0


def test_clerk_user_created_upserts_profile(auth_client, auth_session_factory):
    response = _post_signed(auth_client, _user_event("user.created"))

    assert response.status_code == 200
    assert response.json() == {"type": "user.created", "status": "processed"}
    with auth_session_factory() as db:
        user = db.execute(select(User).where(User.clerk_user_id == "user_clerk_123")).scalar_one()
        assert user.username == "filip"
        assert user.email == "filip@example.com"
        assert user.display_name == "Filip Tanic"
        assert user.avatar_url == "https://example.com/avatar.png"


def test_clerk_user_updated_updates_existing_idempotently(auth_client, auth_session_factory):
    assert _post_signed(auth_client, _user_event("user.created")).status_code == 200
    updated = _user_event(
        "user.updated",
        first_name="Updated",
        last_name="User",
        image_url="https://example.com/updated.png",
        primary_email_address_id="email_updated",
        email_addresses=[
            {"id": "email_old", "email_address": "old@example.com"},
            {"id": "email_updated", "email_address": "updated@example.com"},
        ],
    )
    updated["data"].pop("username")

    first = _post_signed(auth_client, updated)
    second = _post_signed(auth_client, updated)

    assert first.status_code == 200
    assert second.status_code == 200
    with auth_session_factory() as db:
        user = db.execute(select(User).where(User.clerk_user_id == "user_clerk_123")).scalar_one()
        assert db.scalar(select(func.count()).select_from(User)) == 1
        assert user.username == "filip"
        assert user.email == "updated@example.com"
        assert user.display_name == "Updated User"
        assert user.avatar_url == "https://example.com/updated.png"


def test_clerk_user_updated_before_created_creates_user(auth_client, auth_session_factory):
    response = _post_signed(auth_client, _user_event("user.updated", user_id="user_out_of_order"))

    assert response.status_code == 200
    with auth_session_factory() as db:
        user = db.execute(
            select(User).where(User.clerk_user_id == "user_out_of_order")
        ).scalar_one()
        assert user.username == "filip"
        assert user.email == "filip@example.com"


def test_clerk_user_updated_username_collision_falls_back(auth_client, auth_session_factory):
    with auth_session_factory() as db:
        db.add(
            User(
                clerk_user_id="user_existing",
                username="filip",
                email="existing@example.com",
            )
        )
        db.commit()

    response = _post_signed(auth_client, _user_event("user.updated", user_id="user_new"))

    assert response.status_code == 200
    with auth_session_factory() as db:
        user = db.execute(select(User).where(User.clerk_user_id == "user_new")).scalar_one()
        assert user.username != "filip"
        assert user.username.startswith("user_")


def test_clerk_user_deleted_removes_user_and_guest_ids(auth_client, auth_session_factory):
    with auth_session_factory() as db:
        user = User(
            clerk_user_id="user_clerk_123",
            username="filip",
            email="filip@example.com",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        link_guest_id(db, user, "guest-123")

    first = _post_signed(auth_client, _user_event("user.deleted"))
    second = _post_signed(auth_client, _user_event("user.deleted"))

    assert first.status_code == 200
    assert second.status_code == 200
    with auth_session_factory() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0
        assert db.scalar(select(func.count()).select_from(UserGuestId)) == 0


def test_clerk_webhook_ignores_unsupported_events(auth_client, auth_session_factory):
    response = _post_signed(auth_client, {"type": "session.created", "data": {"id": "sess_123"}})

    assert response.status_code == 200
    assert response.json() == {"type": "session.created", "status": "ignored"}
    with auth_session_factory() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0


def _post_signed(
    client: TestClient,
    payload: Mapping[str, Any],
    *,
    timestamp: int | None = None,
) -> Any:
    body, headers = _signed_request(payload, timestamp=timestamp)
    return client.post("/auth/webhooks/clerk", content=body, headers=headers)


def _signed_request(
    payload: Mapping[str, Any],
    *,
    timestamp: int | None = None,
    message_id: str = "msg_test",
) -> tuple[bytes, dict[str, str]]:
    body = _event_body(payload)
    svix_timestamp = str(timestamp or int(time.time()))
    signed_content = b".".join([message_id.encode(), svix_timestamp.encode(), body])
    signature = base64.b64encode(
        hmac.new(WEBHOOK_SECRET_BYTES, signed_content, hashlib.sha256).digest()
    ).decode()
    return body, {
        "content-type": "application/json",
        "svix-id": message_id,
        "svix-timestamp": svix_timestamp,
        "svix-signature": f"v1,{signature}",
    }


def _event_body(payload: Mapping[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()


def _user_event(event_type: str, user_id: str = "user_clerk_123", **data_overrides) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": user_id,
        "username": "filip",
        "first_name": "Filip",
        "last_name": "Tanic",
        "image_url": "https://example.com/avatar.png",
        "primary_email_address_id": "email_primary",
        "email_addresses": [
            {"id": "email_secondary", "email_address": "secondary@example.com"},
            {"id": "email_primary", "email_address": "filip@example.com"},
        ],
    }
    data.update(data_overrides)
    return {"type": event_type, "data": data}
