from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import WebSocketDisconnect

from app.game_actions import GAME_ACTION_NOOP, ConflictGameActionError
from app.schemas.realtime import RealtimeServerMessageAdapter
from app.services.realtime import (
    OnlineGameRealtimeModule,
    RealtimeActionOutcome,
    TurnTimerManager,
)


@dataclass
class FakeGame:
    id: int = 1
    status: str = "active"
    current_player: int = 1
    round_number: int = 1
    turn_seconds: int | None = 5


class FakeSession:
    def __init__(self, store: "FakeStore"):
        self.store = store
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def refresh(self, _obj):
        return None

    def close(self):
        self.closed = True


class FakeStore:
    def __init__(self, game: FakeGame | None = None):
        self.game = game or FakeGame()
        self.sessions: list[FakeSession] = []

    def session_factory(self):
        session = FakeSession(self)
        self.sessions.append(session)
        return session


class FakeAdapter:
    client_actions = {"advance", "finish", "fail"}

    def get_game(self, db: FakeSession, game_id: int):
        assert db.store.game.id == game_id
        return db.store.game

    def serialize_state(self, _db: FakeSession, game: FakeGame) -> dict[str, Any]:
        return {
            "id": game.id,
            "status": game.status,
            "current_player": game.current_player,
            "round_number": game.round_number,
            "turn_seconds": game.turn_seconds,
        }

    def serialize_completed_round(
        self, _db: FakeSession, _game_id: int, round_number: int
    ) -> dict[str, Any]:
        return {"round_number": round_number, "status": "completed"}

    def handle_client_action(
        self,
        _db: FakeSession,
        game: FakeGame,
        *,
        action: str,
        data: dict[str, Any],
        player: int,
    ) -> RealtimeActionOutcome:
        if action == "fail":
            raise ConflictGameActionError("not your turn")
        if action == "finish":
            game.status = "finished"
            return RealtimeActionOutcome(game=game, result="match_won", cancel_timer=True)
        game.current_player = 2 if player == 1 else 1
        return RealtimeActionOutcome(
            game=game,
            result=data.get("result", "correct"),
            completed_round_number=data.get("completed_round_number"),
            schedule_timer=True,
        )

    def handle_time_expired(
        self,
        _db: FakeSession,
        game: FakeGame,
        *,
        expected_player: int,
        expected_round: int,
    ):
        if (
            game.status != "active"
            or game.current_player != expected_player
            or game.round_number != expected_round
        ):
            return GAME_ACTION_NOOP
        game.current_player = 2 if game.current_player == 1 else 1
        return game


class FakeWebSocket:
    def __init__(self, *, fail_send: bool = False):
        self.accepted = False
        self.closed = False
        self.fail_send = fail_send
        self.sent: list[dict[str, Any]] = []

    async def accept(self):
        self.accepted = True

    async def send_json(self, message: dict[str, Any]):
        if self.fail_send:
            raise RuntimeError("send failed")
        self.sent.append(message)

    async def close(self):
        self.closed = True


class DisconnectingWebSocket(FakeWebSocket):
    def __init__(self, on_close):
        super().__init__()
        self._on_close = on_close

    async def close(self):
        await super().close()
        self._on_close(self)


class ReceivingWebSocket(FakeWebSocket):
    def __init__(self, messages: list[Any]):
        super().__init__()
        self._messages = list(messages)

    async def receive_json(self):
        if not self._messages:
            raise WebSocketDisconnect()
        message = self._messages.pop(0)
        if isinstance(message, Exception):
            raise message
        return message


class SleepController:
    def __init__(self):
        self.calls: list[tuple[float, asyncio.Event]] = []

    async def __call__(self, seconds: float):
        release = asyncio.Event()
        self.calls.append((seconds, release))
        await release.wait()

    async def wait_for_call(self, count: int = 1):
        for _ in range(50):
            if len(self.calls) >= count:
                return
            await asyncio.sleep(0)
        raise AssertionError(f"Expected {count} timer sleep call(s), got {len(self.calls)}")

    def release(self, index: int = 0):
        self.calls[index][1].set()


def make_module(game: FakeGame | None = None):
    store = FakeStore(game)
    module = OnlineGameRealtimeModule(
        FakeAdapter(),
        session_factory=store.session_factory,
    )
    return module, store


@pytest.mark.asyncio
async def test_broadcast_removes_failed_connections_and_keeps_successful_player():
    module, _store = make_module()
    good = FakeWebSocket()
    failing = FakeWebSocket(fail_send=True)
    await module.connections.connect(1, 1, good)
    await module.connections.connect(1, 2, failing)

    sent = await module.broadcast_state(
        1,
        {"id": 1, "status": "active", "current_player": 1, "round_number": 1},
        result="correct",
    )

    assert sent == 1
    assert good.sent[0]["type"] == "state"
    assert good.sent[0]["payload"]["result"] == "correct"
    assert 1 in module.connections.connections[1]
    assert 2 not in module.connections.connections[1]


@pytest.mark.asyncio
async def test_disconnect_cleans_connections_without_cancelling_timer():
    sleep = SleepController()
    game = FakeGame(turn_seconds=3)
    module, _store = make_module(game)
    module.timer = TurnTimerManager(module._expire_turn, sleep=sleep)
    websocket = FakeWebSocket()
    await module.connections.connect(1, 1, websocket)
    module.timer.start(1, game.turn_seconds, game.current_player, game.round_number)
    await sleep.wait_for_call()

    module.disconnect(1, 1)
    sleep.release()
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert 1 not in module.connections.connections
    assert game.current_player == 2
    module.cancel_timer(1)


@pytest.mark.asyncio
async def test_stale_reconnect_disconnect_does_not_remove_new_socket():
    module, _store = make_module()
    old_socket = FakeWebSocket()
    new_socket = FakeWebSocket()
    await module.connections.connect(1, 1, old_socket)
    await module.connections.connect(1, 1, new_socket)

    module.disconnect(1, 1, old_socket)
    await module.broadcast_state(1, {"id": 1, "status": "active"})

    assert old_socket.closed is True
    assert new_socket.sent[-1]["payload"]["game"] == {"id": 1, "status": "active"}


@pytest.mark.asyncio
async def test_reconnect_stores_replacement_before_old_socket_close_cleanup():
    module, _store = make_module()
    old_socket = DisconnectingWebSocket(lambda ws: module.disconnect(1, 1, ws))
    new_socket = FakeWebSocket()
    await module.connections.connect(1, 1, old_socket)

    await module.connections.connect(1, 1, new_socket)

    assert old_socket.closed is True
    assert module.connections.connections[1][1] is new_socket


@pytest.mark.asyncio
async def test_timer_expiry_broadcasts_schema_compliant_result_and_reschedules():
    sleep = SleepController()
    game = FakeGame(turn_seconds=3)
    module, _store = make_module(game)
    module.timer = TurnTimerManager(module._expire_turn, sleep=sleep)
    websocket = FakeWebSocket()
    await module.connections.connect(1, 1, websocket)

    module.timer.start(1, game.turn_seconds, game.current_player, game.round_number)
    await sleep.wait_for_call()
    sleep.release()
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert game.current_player == 2
    message = websocket.sent[-1]
    RealtimeServerMessageAdapter.validate_python(message)
    assert message["payload"]["result"] == "time_expired"
    assert module.timer.has_timer(1)
    module.cancel_timer(1)


@pytest.mark.asyncio
async def test_timer_cancellation_prevents_expiry_broadcast():
    sleep = SleepController()
    game = FakeGame(turn_seconds=3)
    module, _store = make_module(game)
    module.timer = TurnTimerManager(module._expire_turn, sleep=sleep)
    websocket = FakeWebSocket()
    await module.connections.connect(1, 1, websocket)

    module.timer.start(1, game.turn_seconds, game.current_player, game.round_number)
    await sleep.wait_for_call()
    module.cancel_timer(1)
    sleep.release()
    await asyncio.sleep(0)

    assert game.current_player == 1
    assert websocket.sent == []


@pytest.mark.asyncio
async def test_timer_expiry_race_guard_ignores_stale_round():
    sleep = SleepController()
    game = FakeGame(turn_seconds=3)
    module, _store = make_module(game)
    module.timer = TurnTimerManager(module._expire_turn, sleep=sleep)
    websocket = FakeWebSocket()
    await module.connections.connect(1, 1, websocket)

    module.timer.start(1, game.turn_seconds, game.current_player, game.round_number)
    await sleep.wait_for_call()
    game.round_number = 2
    sleep.release()
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert game.current_player == 1
    assert websocket.sent == []


@pytest.mark.asyncio
async def test_unknown_and_domain_errors_are_schema_compliant():
    module, _store = make_module()
    websocket = FakeWebSocket()

    await module.handle_client_message(websocket, 1, 1, {"action": "unknown"})
    await module.handle_client_message(websocket, 1, 2, {"action": "fail"})

    assert websocket.sent[0] == {
        "type": "error",
        "payload": {"code": "unknown_action", "message": "Unknown action: unknown"},
    }
    assert websocket.sent[1] == {
        "type": "error",
        "payload": {"code": "conflict", "message": "not your turn"},
    }
    for message in websocket.sent:
        RealtimeServerMessageAdapter.validate_python(message)


@pytest.mark.asyncio
async def test_malformed_client_messages_are_schema_compliant_errors():
    module, _store = make_module()
    websocket = FakeWebSocket()

    await module.handle_client_message(websocket, 1, 1, ["move"])
    await module.handle_client_message(websocket, 1, 1, {"action": []})
    await module.handle_client_message(websocket, 1, 1, {"action": {}})

    assert websocket.sent == [
        {
            "type": "error",
            "payload": {
                "code": "invalid_input",
                "message": "Realtime messages must be JSON objects",
            },
        },
        {
            "type": "error",
            "payload": {
                "code": "invalid_input",
                "message": "Realtime action must be a string",
            },
        },
        {
            "type": "error",
            "payload": {
                "code": "invalid_input",
                "message": "Realtime action must be a string",
            },
        },
    ]
    for message in websocket.sent:
        RealtimeServerMessageAdapter.validate_python(message)


@pytest.mark.asyncio
async def test_connect_rejects_malformed_messages_without_dropping_connection():
    module, _store = make_module()
    websocket = ReceivingWebSocket(
        [
            ["move"],
            ValueError("invalid json"),
            {"action": "advance", "result": "correct"},
            WebSocketDisconnect(),
        ]
    )

    await module.connect(websocket, 1, 1)

    assert websocket.sent[1] == {
        "type": "error",
        "payload": {
            "code": "invalid_input",
            "message": "Realtime messages must be JSON objects",
        },
    }
    assert websocket.sent[2] == {
        "type": "error",
        "payload": {
            "code": "invalid_input",
            "message": "Invalid realtime message JSON",
        },
    }
    assert websocket.sent[3]["payload"]["result"] == "correct"
    for message in websocket.sent:
        RealtimeServerMessageAdapter.validate_python(message)


@pytest.mark.asyncio
async def test_action_result_message_can_include_completed_round_payload():
    module, _store = make_module()
    websocket = FakeWebSocket()
    await module.connections.connect(1, 1, websocket)

    await module.handle_client_message(
        websocket,
        1,
        1,
        {"action": "advance", "result": "round_won", "completed_round_number": 7},
    )

    message = websocket.sent[-1]
    RealtimeServerMessageAdapter.validate_python(message)
    assert message["payload"]["result"] == "round_won"
    assert message["payload"]["completed_round"] == {
        "round_number": 7,
        "status": "completed",
    }
    module.cancel_timer(1)
