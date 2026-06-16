from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from app.game_actions import InvalidGameActionError
from app.services.game_action_orchestration import (
    GameActionCommand,
    GameActionName,
    GameActionOrchestrator,
    HttpGameActionRejected,
    RealtimeActionOutcome,
)


@dataclass
class FakeGame:
    id: int = 1
    mode: str = "online_friend"
    status: str = "active"
    current_player: int = 1
    round_number: int = 1
    turn_seconds: int | None = 40


class FakeSession:
    def __init__(self, game: FakeGame):
        self.game = game
        self.commits = 0
        self.rollbacks = 0

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def refresh(self, _obj):
        return None


class FakeAdapter:
    http_actions = {GameActionName.CREATE.value, GameActionName.MOVE.value}
    websocket_actions = {GameActionName.MOVE.value}

    def get_game(self, db: FakeSession, game_id: int):
        assert game_id == db.game.id
        return db.game

    def serialize_state(self, _db: FakeSession, game: FakeGame) -> dict[str, Any]:
        return {
            "id": game.id,
            "mode": game.mode,
            "status": game.status,
            "current_player": game.current_player,
            "round_number": game.round_number,
            "turn_seconds": game.turn_seconds,
        }

    def serialize_completed_round(
        self, _db: FakeSession, _game_id: int, round_number: int
    ) -> dict[str, Any]:
        return {"round_number": round_number}

    def handle_game_action(
        self, db: FakeSession, command: GameActionCommand
    ) -> RealtimeActionOutcome:
        if command.action == GameActionName.CREATE:
            db.game = FakeGame(id=99, mode="single_player", turn_seconds=None)
            return RealtimeActionOutcome(game=db.game, broadcast=False)

        game = self.get_game(db, command.game_id)
        if game.mode == "online_friend" and command.player is None:
            raise InvalidGameActionError("Online game actions require player identity")
        previous_round = game.round_number
        game.current_player = 2
        return RealtimeActionOutcome(
            game=game,
            result="round_won",
            completed_round_number=previous_round,
            schedule_timer=True,
            broadcast_to_player=command.payload.get("broadcast_to_player"),
        )


class FakeEffects:
    def __init__(self, *, fail: bool = False):
        self.fail = fail
        self.broadcasts = []
        self.started = []
        self.cancelled = []

    async def broadcast_state(self, game_id: int, game_state: dict[str, Any], **kwargs):
        if self.fail:
            raise RuntimeError("broadcast failed")
        self.broadcasts.append((game_id, game_state, kwargs))
        return 1

    def start_timer_from_state(self, game_state: dict[str, Any]) -> None:
        if self.fail:
            raise RuntimeError("timer failed")
        self.started.append(game_state["id"])

    def cancel_timer(self, game_id: int) -> None:
        if self.fail:
            raise RuntimeError("timer failed")
        self.cancelled.append(game_id)


def _orchestrator(effects: FakeEffects | None = None) -> GameActionOrchestrator:
    return GameActionOrchestrator(FakeAdapter(), effects or FakeEffects())


@pytest.mark.asyncio
async def test_http_and_websocket_actions_share_state_envelope_shape():
    http_db = FakeSession(FakeGame())
    ws_db = FakeSession(FakeGame())
    orchestrator = _orchestrator()

    http_envelope = await orchestrator.http_action(
        db=http_db,
        action=GameActionName.MOVE,
        payload={},
        game_id=1,
        player=1,
    )
    ws_envelope = await orchestrator.websocket_action(
        db=ws_db,
        action=GameActionName.MOVE.value,
        payload={},
        game_id=1,
        player=1,
    )

    assert http_envelope == ws_envelope
    assert http_envelope["type"] == "state"
    assert http_envelope["payload"]["completed_round"] == {"round_number": 1}
    assert http_db.commits == 1
    assert ws_db.commits == 1


@pytest.mark.asyncio
async def test_create_action_returns_state_envelope_with_game_id():
    db = FakeSession(FakeGame())

    envelope = await _orchestrator().http_action(
        db=db,
        action=GameActionName.CREATE,
        payload={},
    )

    assert envelope["type"] == "state"
    assert envelope["payload"]["game"]["id"] == 99


@pytest.mark.asyncio
async def test_websocket_rejects_http_only_action_at_seam():
    db = FakeSession(FakeGame())

    envelope = await _orchestrator().websocket_action(
        db=db,
        action=GameActionName.CREATE.value,
        payload={},
        game_id=1,
        player=1,
    )

    assert envelope == {
        "type": "error",
        "payload": {
            "code": "unsupported",
            "message": "Unsupported websocket game action: create",
        },
    }
    assert db.commits == 0


@pytest.mark.asyncio
async def test_http_game_action_error_uses_realtime_error_envelope():
    db = FakeSession(FakeGame())

    with pytest.raises(HttpGameActionRejected) as exc_info:
        await _orchestrator().http_action(
            db=db,
            action=GameActionName.MOVE,
            payload={},
            game_id=1,
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.envelope == {
        "type": "error",
        "payload": {
            "code": "invalid_input",
            "message": "Online game actions require player identity",
        },
    }
    assert db.rollbacks == 1


@pytest.mark.asyncio
async def test_post_commit_side_effect_failures_are_logged_and_state_wins(caplog):
    db = FakeSession(FakeGame())
    orchestrator = _orchestrator(FakeEffects(fail=True))

    envelope = await orchestrator.http_action(
        db=db,
        action=GameActionName.MOVE,
        payload={},
        game_id=1,
        player=1,
    )

    assert envelope["type"] == "state"
    assert db.commits == 1
    assert "Post-commit game action side effect failed" in caplog.text


@pytest.mark.asyncio
async def test_broadcast_can_be_targeted_to_one_player():
    db = FakeSession(FakeGame())
    effects = FakeEffects()

    await _orchestrator(effects).websocket_action(
        db=db,
        action=GameActionName.MOVE.value,
        payload={"broadcast_to_player": 1},
        game_id=1,
        player=1,
    )

    assert effects.broadcasts[0][2]["only_player"] == 1
