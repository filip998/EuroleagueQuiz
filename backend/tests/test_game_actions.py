import pytest
from fastapi import HTTPException

from app.game_actions import (
    GAME_ACTION_NOOP,
    ConflictGameActionError,
    InvalidGameActionError,
    run_game_action,
    run_http_game_action,
    websocket_error_payload,
)


class FakeSession:
    def __init__(self):
        self.commits = 0
        self.rollbacks = 0

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def _raise(exc: Exception):
    raise exc


def test_run_game_action_commits_success():
    session = FakeSession()

    result = run_game_action(session, lambda: "ok")

    assert result == "ok"
    assert session.commits == 1
    assert session.rollbacks == 0


def test_run_game_action_rolls_back_domain_error():
    session = FakeSession()

    with pytest.raises(ConflictGameActionError):
        run_game_action(session, lambda: _raise(ConflictGameActionError("busy")))

    assert session.commits == 0
    assert session.rollbacks == 1


def test_run_game_action_rolls_back_unexpected_error():
    session = FakeSession()

    with pytest.raises(RuntimeError):
        run_game_action(session, lambda: _raise(RuntimeError("boom")))

    assert session.commits == 0
    assert session.rollbacks == 1


def test_run_game_action_noop_rolls_back_without_commit():
    session = FakeSession()

    result = run_game_action(session, lambda: GAME_ACTION_NOOP)

    assert result is GAME_ACTION_NOOP
    assert session.commits == 0
    assert session.rollbacks == 1


def test_run_http_game_action_maps_domain_error():
    session = FakeSession()

    with pytest.raises(HTTPException) as exc_info:
        run_http_game_action(
            session,
            lambda: _raise(InvalidGameActionError("bad input")),
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "bad input"
    assert session.rollbacks == 1


def test_websocket_error_payload_preserves_public_message():
    assert websocket_error_payload(ConflictGameActionError("not your turn")) == {
        "type": "error",
        "payload": {"code": "conflict", "message": "not your turn"},
    }
