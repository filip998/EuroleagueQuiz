from __future__ import annotations

import asyncio
import threading
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
        self.owner_thread_id = threading.get_ident()
        self.method_thread_ids: list[int] = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def _assert_owner_thread(self):
        current_thread_id = threading.get_ident()
        self.method_thread_ids.append(current_thread_id)
        assert current_thread_id == self.owner_thread_id

    def commit(self):
        self._assert_owner_thread()
        self.commits += 1

    def rollback(self):
        self._assert_owner_thread()
        self.rollbacks += 1

    def refresh(self, _obj):
        self._assert_owner_thread()
        return None

    def close(self):
        self._assert_owner_thread()
        self.closed = True


class FakeStore:
    def __init__(self, game: FakeGame | None = None):
        self.game = game or FakeGame()
        self.sessions: list[FakeSession] = []

    def session_factory(self) -> FakeSession:
        session = FakeSession(self.game)
        self.sessions.append(session)
        return session


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


class BlockingEffects(FakeEffects):
    def __init__(self):
        super().__init__()
        self.first_broadcast_started = asyncio.Event()
        self.release_first_broadcast = asyncio.Event()

    async def broadcast_state(self, game_id: int, game_state: dict[str, Any], **kwargs):
        if not self.broadcasts:
            self.broadcasts.append((game_id, game_state, kwargs))
            self.first_broadcast_started.set()
            await self.release_first_broadcast.wait()
            return 1
        return await super().broadcast_state(game_id, game_state, **kwargs)


def _orchestrator(
    effects: FakeEffects | None = None,
    *,
    store: FakeStore | None = None,
) -> GameActionOrchestrator:
    active_store = store or FakeStore()
    return GameActionOrchestrator(
        FakeAdapter(),
        effects or FakeEffects(),
        session_factory=active_store.session_factory,
    )


@pytest.mark.asyncio
async def test_http_and_websocket_actions_share_state_envelope_shape():
    http_store = FakeStore()
    ws_store = FakeStore()
    http_orchestrator = _orchestrator(store=http_store)
    ws_orchestrator = _orchestrator(store=ws_store)

    http_envelope = await http_orchestrator.http_action(
        action=GameActionName.MOVE,
        payload={},
        game_id=1,
        player=1,
    )
    ws_envelope = await ws_orchestrator.websocket_action(
        action=GameActionName.MOVE.value,
        payload={},
        game_id=1,
        player=1,
    )

    assert http_envelope == ws_envelope
    assert http_envelope["type"] == "state"
    assert http_envelope["payload"]["completed_round"] == {"round_number": 1}
    assert http_store.sessions[0].commits == 1
    assert ws_store.sessions[0].commits == 1


@pytest.mark.asyncio
async def test_create_action_returns_state_envelope_with_game_id():
    store = FakeStore()

    envelope = await _orchestrator(store=store).http_action(
        action=GameActionName.CREATE,
        payload={},
    )

    assert envelope["type"] == "state"
    assert envelope["payload"]["game"]["id"] == 99


@pytest.mark.asyncio
async def test_websocket_rejects_http_only_action_at_seam():
    store = FakeStore()

    envelope = await _orchestrator(store=store).websocket_action(
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
    assert store.sessions == []


@pytest.mark.asyncio
async def test_http_game_action_error_uses_realtime_error_envelope():
    store = FakeStore()

    with pytest.raises(HttpGameActionRejected) as exc_info:
        await _orchestrator(store=store).http_action(
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
    assert store.sessions[0].rollbacks == 1


@pytest.mark.asyncio
async def test_post_commit_side_effect_failures_are_logged_and_state_wins(caplog):
    store = FakeStore()
    orchestrator = _orchestrator(FakeEffects(fail=True), store=store)

    envelope = await orchestrator.http_action(
        action=GameActionName.MOVE,
        payload={},
        game_id=1,
        player=1,
    )

    assert envelope["type"] == "state"
    assert store.sessions[0].commits == 1
    assert "Post-commit game action side effect failed" in caplog.text


@pytest.mark.asyncio
async def test_broadcast_can_be_targeted_to_one_player():
    store = FakeStore()
    effects = FakeEffects()

    await _orchestrator(effects, store=store).websocket_action(
        action=GameActionName.MOVE.value,
        payload={"broadcast_to_player": 1},
        game_id=1,
        player=1,
    )

    assert effects.broadcasts[0][2]["only_player"] == 1


@pytest.mark.asyncio
async def test_game_action_session_is_created_and_used_in_worker_thread():
    event_loop_thread_id = threading.get_ident()
    store = FakeStore()

    await _orchestrator(store=store).http_action(
        action=GameActionName.MOVE,
        payload={},
        game_id=1,
        player=1,
    )

    session = store.sessions[0]
    assert session.owner_thread_id != event_loop_thread_id
    assert session.method_thread_ids
    assert set(session.method_thread_ids) == {session.owner_thread_id}
    assert session.closed is True


@pytest.mark.asyncio
async def test_same_game_actions_are_serialized_through_post_commit_effects():
    store = FakeStore()
    effects = BlockingEffects()
    orchestrator = _orchestrator(effects, store=store)

    first = asyncio.create_task(
        orchestrator.websocket_action(
            action=GameActionName.MOVE.value,
            payload={},
            game_id=1,
            player=1,
        )
    )
    await effects.first_broadcast_started.wait()

    second = asyncio.create_task(
        orchestrator.websocket_action(
            action=GameActionName.MOVE.value,
            payload={},
            game_id=1,
            player=1,
        )
    )
    await asyncio.sleep(0)

    assert len(store.sessions) == 1
    effects.release_first_broadcast.set()
    await asyncio.gather(first, second)

    assert len(store.sessions) == 2
    assert len(effects.broadcasts) == 2
