from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app.database import SessionFactory, SessionLocal
from app.game_actions import (
    GameActionCode,
    GameActionError,
    InvalidGameActionError,
    http_exception_for_game_action_error,
    run_game_action,
    websocket_error_payload,
)
from app.schemas.realtime import (
    RealtimeResult,
    error_message,
    state_message,
    unknown_action_message,
)
from app.services.timing import timed_phase

logger = logging.getLogger(__name__)


class GameKind(StrEnum):
    TICTACTOE = "tictactoe"
    GUESS_THE_LIST = "guess_the_list"
    CAREER_QUIZ = "career_quiz"
    PHOTO_QUIZ = "photo_quiz"


class GameActionName(StrEnum):
    CREATE = "create"
    JOIN = "join"
    MOVE = "move"
    GUESS = "guess"
    OFFER_DRAW = "offer_draw"
    RESPOND_DRAW = "respond_draw"
    OFFER_END = "offer_end"
    RESPOND_END = "respond_end"
    OFFER_NO_ANSWER = "offer_no_answer"
    RESPOND_NO_ANSWER = "respond_no_answer"
    GIVE_UP = "give_up"


@dataclass
class RealtimeActionOutcome:
    game: Any
    result: RealtimeResult | str | None = None
    completed_round_number: int | None = None
    completed_round: dict[str, Any] | None = None
    broadcast: bool = True
    broadcast_to_player: int | None = None
    schedule_timer: bool = False
    cancel_timer: bool = False


@dataclass(frozen=True)
class GameActionExecution:
    state: dict[str, Any]
    envelope: dict[str, Any]
    result: RealtimeResult | str | None
    completed_round: dict[str, Any] | None
    broadcast: bool
    broadcast_to_player: int | None
    schedule_timer: bool
    cancel_timer: bool


@dataclass(frozen=True)
class GameActionCommand:
    action: str
    payload: dict[str, Any]
    game_id: int | None = None
    player: int | None = None
    source: str = "http"


@dataclass
class _ActionLockEntry:
    lock: asyncio.Lock
    waiters: int = 0


class HttpGameActionRejected(Exception):
    def __init__(self, status_code: int, envelope: dict[str, Any]):
        super().__init__(envelope["payload"]["message"])
        self.status_code = status_code
        self.envelope = envelope


class GameActionAdapter(Protocol):
    http_actions: set[str]
    websocket_actions: set[str]

    def get_game(self, db: Session, game_id: int) -> Any: ...

    def serialize_state(self, db: Session, game: Any) -> dict[str, Any]: ...

    def serialize_completed_round(
        self, db: Session, game_id: int, round_number: int
    ) -> dict[str, Any] | None: ...

    def handle_game_action(
        self,
        db: Session,
        command: GameActionCommand,
    ) -> RealtimeActionOutcome: ...


class RealtimeEffects(Protocol):
    async def broadcast_state(
        self,
        game_id: int,
        game_state: dict[str, Any],
        *,
        result: RealtimeResult | str | None = None,
        completed_round: dict[str, Any] | None = None,
        only_player: int | None = None,
    ) -> int: ...

    def start_timer_from_state(self, game_state: dict[str, Any]) -> None: ...

    def cancel_timer(self, game_id: int) -> None: ...


class GameActionOrchestrator:
    def __init__(
        self,
        adapter: GameActionAdapter,
        realtime_effects: RealtimeEffects,
        *,
        session_factory: SessionFactory = SessionLocal,
        log: logging.Logger | None = None,
    ):
        self.adapter = adapter
        self.realtime_effects = realtime_effects
        self.session_factory = session_factory
        self.log = log or logger
        self._action_locks: dict[str, _ActionLockEntry] = {}

    async def http_action(
        self,
        *,
        action: str | GameActionName,
        payload: Any = None,
        game_id: int | None = None,
        player: int | None = None,
        session_factory: SessionFactory | None = None,
    ) -> dict[str, Any]:
        action_value = _action_value(action)
        if action_value not in self._http_actions():
            raise _http_rejected(
                501,
                f"Unsupported HTTP game action: {action_value}",
                code=GameActionCode.UNSUPPORTED.value,
            )

        try:
            return await self._execute(
                GameActionCommand(
                    action=action_value,
                    payload=_payload_dict(payload),
                    game_id=game_id,
                    player=player,
                    source="http",
                ),
                session_factory=session_factory,
            )
        except GameActionError as exc:
            raise _http_rejected_for_game_action(exc) from exc
        except Exception as exc:
            self.log.exception("Unexpected HTTP game action failure")
            raise _http_rejected(
                500,
                "Internal game action error",
                code=GameActionCode.INTERNAL.value,
            ) from exc

    async def websocket_action(
        self,
        *,
        action: str,
        payload: dict[str, Any],
        game_id: int,
        player: int,
        session_factory: SessionFactory | None = None,
    ) -> dict[str, Any]:
        known_actions = self._http_actions() | self._websocket_actions()
        if action not in known_actions:
            return unknown_action_message(action)
        if action not in self._websocket_actions():
            return error_message(
                f"Unsupported websocket game action: {action}",
                code=GameActionCode.UNSUPPORTED.value,
            )

        try:
            return await self._execute(
                GameActionCommand(
                    action=action,
                    payload=_payload_dict(payload),
                    game_id=game_id,
                    player=player,
                    source="websocket",
                ),
                session_factory=session_factory,
            )
        except GameActionError as exc:
            return websocket_error_payload(exc)
        except Exception:
            self.log.exception("Unexpected websocket game action failure")
            return error_message(
                "Internal game action error",
                code=GameActionCode.INTERNAL.value,
            )

    async def _execute(
        self,
        command: GameActionCommand,
        *,
        session_factory: SessionFactory | None = None,
    ) -> dict[str, Any]:
        factory = session_factory or self.session_factory
        async with self._command_lock(command):
            execution = await run_in_threadpool(
                self._execute_in_worker,
                factory,
                command,
            )
            await self._apply_realtime_effects(execution)
            return execution.envelope

    def _execute_in_worker(
        self,
        session_factory: SessionFactory,
        command: GameActionCommand,
    ) -> GameActionExecution:
        db = session_factory()
        try:
            outcome = run_game_action(
                db,
                lambda: self._handle_adapter_action(db, command),
            )

            db.refresh(outcome.game)
            with timed_phase("response.state_serialization"):
                state = self.adapter.serialize_state(db, outcome.game)
                completed_round = outcome.completed_round
                if completed_round is None and outcome.completed_round_number is not None:
                    with timed_phase("response.completed_round_serialization"):
                        completed_round = self.adapter.serialize_completed_round(
                            db,
                            state["id"],
                            outcome.completed_round_number,
                        )

                envelope = state_message(
                    state,
                    result=outcome.result,
                    completed_round=completed_round,
                )
            return GameActionExecution(
                state=state,
                envelope=envelope,
                result=outcome.result,
                completed_round=completed_round,
                broadcast=outcome.broadcast,
                broadcast_to_player=outcome.broadcast_to_player,
                schedule_timer=outcome.schedule_timer,
                cancel_timer=outcome.cancel_timer,
            )
        finally:
            db.close()

    async def _apply_realtime_effects(
        self,
        execution: GameActionExecution,
    ) -> None:
        state = execution.state
        if state.get("mode", "online_friend") != "online_friend":
            return

        game_id = state["id"]
        if execution.cancel_timer:
            self._log_post_commit_failure(
                "cancel timer",
                lambda: self.realtime_effects.cancel_timer(game_id),
            )
        if execution.schedule_timer and state.get("status") == "active":
            self._log_post_commit_failure(
                "start timer",
                lambda: self.realtime_effects.start_timer_from_state(state),
            )
        if execution.broadcast:
            try:
                await self.realtime_effects.broadcast_state(
                    game_id,
                    state,
                    result=execution.result,
                    completed_round=execution.completed_round,
                    only_player=execution.broadcast_to_player,
                )
            except Exception:
                self.log.exception(
                    "Post-commit game action side effect failed: broadcast state"
                )

    @asynccontextmanager
    async def _command_lock(self, command: GameActionCommand):
        async with self.action_lock(_command_lock_key(command)):
            yield

    @asynccontextmanager
    async def game_lock(self, game_id: int):
        async with self.action_lock(f"game:{game_id}"):
            yield

    @asynccontextmanager
    async def action_lock(self, key: str | None):
        if key is None:
            yield
            return
        entry = self._action_locks.get(key)
        if entry is None:
            entry = _ActionLockEntry(asyncio.Lock())
            self._action_locks[key] = entry
        entry.waiters += 1
        try:
            async with entry.lock:
                yield
        finally:
            entry.waiters -= 1
            if entry.waiters == 0 and not entry.lock.locked():
                self._action_locks.pop(key, None)

    def _log_post_commit_failure(self, effect: str, run: Any) -> None:
        try:
            run()
        except Exception:
            self.log.exception("Post-commit game action side effect failed: %s", effect)

    def _http_actions(self) -> set[str]:
        return set(getattr(self.adapter, "http_actions", set()))

    def _websocket_actions(self) -> set[str]:
        return set(
            getattr(
                self.adapter,
                "websocket_actions",
                getattr(self.adapter, "client_actions", set()),
            )
        )

    def _handle_adapter_action(
        self,
        db: Session,
        command: GameActionCommand,
    ) -> RealtimeActionOutcome:
        handle_game_action = getattr(self.adapter, "handle_game_action", None)
        if handle_game_action is not None:
            return handle_game_action(db, command)

        if command.game_id is None:
            raise ValueError("Fallback realtime adapter requires game_id")
        game = self.adapter.get_game(db, command.game_id)
        return self.adapter.handle_client_action(
            db,
            game,
            action=command.action,
            data=command.payload,
            player=command.player,
        )


def _action_value(action: str | GameActionName) -> str:
    return action.value if isinstance(action, GameActionName) else str(action)


def _payload_dict(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {}
    if hasattr(payload, "model_dump"):
        return payload.model_dump()
    if isinstance(payload, dict):
        return dict(payload)
    raise InvalidGameActionError("Game action payload must be an object")


def _command_lock_key(command: GameActionCommand) -> str | None:
    if command.game_id is not None:
        return f"game:{command.game_id}"
    if command.action == GameActionName.JOIN:
        join_code = command.payload.get("join_code")
        if isinstance(join_code, str) and join_code.strip():
            return f"join:{join_code.strip().upper()}"
    return None


def _http_rejected(
    status_code: int,
    message: str,
    *,
    code: str,
) -> HttpGameActionRejected:
    return HttpGameActionRejected(status_code, error_message(message, code=code))


def _http_rejected_for_game_action(exc: GameActionError) -> HttpGameActionRejected:
    http_exc = http_exception_for_game_action_error(exc)
    return HttpGameActionRejected(http_exc.status_code, websocket_error_payload(exc))
