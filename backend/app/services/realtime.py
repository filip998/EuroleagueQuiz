from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.auth.clerk import (
    ClerkAuthConfigurationError,
    ClerkAuthError,
    ClerkAuthServiceError,
    get_clerk_jwt_verifier,
)
from app.auth.users import UserProvisioningError, get_or_create_user_for_claims
from app.auth_database import SessionLocal as AuthSessionLocal
from app.config import settings
from app.database import SessionFactory, SessionLocal
from app.game_actions import (
    GAME_ACTION_NOOP,
    GameActionError,
    GameActionNoop,
    run_game_action,
)
from app.schemas.realtime import (
    RealtimeClientAction,
    RealtimeResult,
    error_message,
    is_terminal_result,
    state_message,
)
from app.services.game_action_orchestration import (
    GameActionOrchestrator,
    RealtimeActionOutcome,
)
from app.models.user import User

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RealtimeConnectionContext:
    user: User | None = None


@dataclass(frozen=True)
class TurnTimerState:
    seconds: float | None
    current_player: int
    round_number: int


class OnlineGameAdapter(Protocol):
    client_actions: set[str]
    disconnect_forfeit_enabled: bool

    def get_game(self, db: Session, game_id: int) -> Any: ...

    def serialize_state(self, db: Session, game: Any) -> dict[str, Any]: ...

    def serialize_completed_round(
        self, db: Session, game_id: int, round_number: int
    ) -> dict[str, Any] | None: ...

    def handle_client_action(
        self,
        db: Session,
        game: Any,
        *,
        action: str,
        data: dict[str, Any],
        player: int,
    ) -> RealtimeActionOutcome: ...

    def handle_time_expired(
        self,
        db: Session,
        game: Any,
        *,
        expected_player: int,
        expected_round: int,
    ) -> Any | GameActionNoop: ...

    def handle_player_forfeit(
        self,
        db: Session,
        game: Any,
        *,
        forfeiting_player: int,
        result: RealtimeResult,
    ) -> Any | GameActionNoop: ...


class ConnectionManager:
    def __init__(self):
        self.connections: dict[int, dict[int, WebSocket]] = {}
        self.contexts: dict[int, dict[int, RealtimeConnectionContext]] = {}

    async def connect(
        self,
        game_id: int,
        player: int,
        websocket: WebSocket,
        *,
        context: RealtimeConnectionContext | None = None,
    ) -> None:
        await websocket.accept()
        players = self.connections.setdefault(game_id, {})
        contexts = self.contexts.setdefault(game_id, {})
        previous = players.get(player)
        players[player] = websocket
        contexts[player] = context or RealtimeConnectionContext()
        if previous is not None and previous is not websocket:
            await _close_quietly(previous)

    def disconnect(
        self, game_id: int, player: int, websocket: WebSocket | None = None
    ) -> bool:
        players = self.connections.get(game_id)
        if not players:
            return False
        if websocket is not None and players.get(player) is not websocket:
            return False
        if player not in players:
            return False
        players.pop(player, None)
        contexts = self.contexts.get(game_id)
        if contexts is not None:
            contexts.pop(player, None)
            if not contexts:
                self.contexts.pop(game_id, None)
        if not players:
            self.connections.pop(game_id, None)
        return True

    def has_player(self, game_id: int, player: int) -> bool:
        return player in self.connections.get(game_id, {})

    def get_context(
        self, game_id: int, player: int
    ) -> RealtimeConnectionContext | None:
        return self.contexts.get(game_id, {}).get(player)

    async def broadcast(
        self,
        game_id: int,
        message: dict[str, Any],
        *,
        only_player: int | None = None,
        on_disconnect: Callable[[int, WebSocket], None] | None = None,
    ) -> int:
        sent = 0
        if only_player is None:
            players = list(self.connections.get(game_id, {}).items())
        else:
            websocket = self.connections.get(game_id, {}).get(only_player)
            players = [] if websocket is None else [(only_player, websocket)]
        for player, websocket in players:
            try:
                await websocket.send_json(message)
                sent += 1
            except Exception:
                if self.disconnect(game_id, player, websocket) and on_disconnect:
                    on_disconnect(player, websocket)
        return sent


async def _close_quietly(websocket: WebSocket) -> None:
    close = getattr(websocket, "close", None)
    if close is None:
        return
    try:
        result = close()
        if asyncio.iscoroutine(result):
            await result
    except Exception:
        return


class TurnTimerManager:
    def __init__(
        self,
        on_expire: Callable[[int, int, int], Awaitable[None]],
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self._on_expire = on_expire
        self._sleep = sleep
        self._timers: dict[int, asyncio.Task] = {}

    def start(
        self,
        game_id: int,
        turn_seconds: float | None,
        current_player: int,
        round_number: int,
    ) -> None:
        self.cancel(game_id)
        if not turn_seconds:
            return

        async def _run() -> None:
            await self._sleep(turn_seconds)
            if self._timers.get(game_id) is asyncio.current_task():
                self._timers.pop(game_id, None)
            await self._on_expire(game_id, current_player, round_number)

        loop = asyncio.get_running_loop()
        self._timers[game_id] = loop.create_task(_run())

    def cancel(self, game_id: int) -> None:
        task = self._timers.pop(game_id, None)
        if task and not task.done():
            task.cancel()

    def has_timer(self, game_id: int) -> bool:
        task = self._timers.get(game_id)
        return bool(task and not task.done())


class DisconnectGraceTimerManager:
    def __init__(
        self,
        on_expire: Callable[[int, int], Awaitable[None]],
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self._on_expire = on_expire
        self._sleep = sleep
        self._timers: dict[tuple[int, int], asyncio.Task] = {}

    def start(self, game_id: int, player: int, grace_seconds: float) -> None:
        key = (game_id, player)
        self.cancel(game_id, player)

        async def _run() -> None:
            await self._sleep(max(grace_seconds, 0.0))
            if self._timers.get(key) is asyncio.current_task():
                self._timers.pop(key, None)
            await self._on_expire(game_id, player)

        loop = asyncio.get_running_loop()
        self._timers[key] = loop.create_task(_run())

    def cancel(self, game_id: int, player: int) -> None:
        task = self._timers.pop((game_id, player), None)
        if task and not task.done():
            task.cancel()

    def cancel_game(self, game_id: int) -> None:
        current_task = asyncio.current_task()
        for key, task in list(self._timers.items()):
            if key[0] != game_id or task is current_task:
                continue
            self._timers.pop(key, None)
            if not task.done():
                task.cancel()

    def has_timer(self, game_id: int, player: int) -> bool:
        task = self._timers.get((game_id, player))
        return bool(task and not task.done())

    def has_game_timer(self, game_id: int) -> bool:
        return any(
            key_game_id == game_id and not task.done()
            for (key_game_id, _), task in self._timers.items()
        )


class OnlineGameRealtimeModule:
    def __init__(
        self,
        adapter: OnlineGameAdapter,
        *,
        session_factory: Callable[[], Session] = SessionLocal,
        auth_session_factory: Callable[[], Session] = AuthSessionLocal,
        connections: ConnectionManager | None = None,
        timer: TurnTimerManager | None = None,
        disconnect_grace_timer: DisconnectGraceTimerManager | None = None,
        disconnect_grace_seconds: float | None = None,
    ):
        self.adapter = adapter
        self.session_factory = session_factory
        self.auth_session_factory = auth_session_factory
        self.connections = connections or ConnectionManager()
        self.timer = timer or TurnTimerManager(self._expire_turn)
        self.disconnect_grace_timer = (
            disconnect_grace_timer
            or DisconnectGraceTimerManager(self._expire_disconnect_grace)
        )
        self.disconnect_grace_seconds = (
            settings.online_disconnect_grace_seconds
            if disconnect_grace_seconds is None
            else disconnect_grace_seconds
        )
        self._broadcast_locks: dict[int, asyncio.Lock] = {}
        self.game_actions = GameActionOrchestrator(
            adapter,
            self,
            session_factory=session_factory,
            log=logger,
        )

    async def connect(
        self,
        websocket: WebSocket,
        game_id: int,
        player: int,
        *,
        session_factory: SessionFactory | None = None,
    ) -> None:
        active_session_factory = session_factory or self.session_factory
        try:
            await self._send_initial_state(
                websocket,
                game_id,
                player,
                session_factory=active_session_factory,
            )
            while True:
                try:
                    data = await websocket.receive_json()
                except ValueError:
                    await websocket.send_json(
                        error_message(
                            "Invalid realtime message JSON", code="invalid_input"
                        )
                    )
                    continue

                if not isinstance(data, dict):
                    await websocket.send_json(
                        error_message(
                            "Realtime messages must be JSON objects",
                            code="invalid_input",
                        )
                    )
                    continue

                await self.handle_client_message(
                    websocket,
                    game_id,
                    player,
                    data,
                    session_factory=active_session_factory,
                )
        except WebSocketDisconnect:
            self.disconnect(game_id, player, websocket)
        except Exception:
            self.disconnect(game_id, player, websocket)
            raise

    async def _send_initial_state(
        self,
        websocket: WebSocket,
        game_id: int,
        player: int,
        *,
        session_factory: SessionFactory | None = None,
    ) -> None:
        db = (session_factory or self.session_factory)()
        try:
            game = self.adapter.get_game(db, game_id)
            state = self.adapter.serialize_state(db, game)
        finally:
            db.close()
        context = await self._connection_context_from_websocket(websocket)

        await self.connections.connect(game_id, player, websocket, context=context)
        self.disconnect_grace_timer.cancel(game_id, player)
        await websocket.send_json(state_message(state))

    async def _connection_context_from_websocket(
        self, websocket: WebSocket
    ) -> RealtimeConnectionContext:
        token = _websocket_query_param(websocket, "token")
        if token is None:
            return RealtimeConnectionContext()
        try:
            user = await asyncio.to_thread(self._resolve_realtime_user, token)
        except ClerkAuthError:
            return RealtimeConnectionContext()
        except (ClerkAuthConfigurationError, ClerkAuthServiceError):
            logger.warning(
                "Realtime WebSocket auth unavailable; falling back to guest",
                exc_info=True,
            )
            return RealtimeConnectionContext()
        except (SQLAlchemyError, UserProvisioningError):
            logger.exception(
                "Failed to resolve realtime WebSocket user; falling back to guest"
            )
            return RealtimeConnectionContext()
        return RealtimeConnectionContext(user=user)

    def _resolve_realtime_user(self, token: str) -> User:
        claims = get_clerk_jwt_verifier().verify(token)
        db = self.auth_session_factory()
        try:
            return get_or_create_user_for_claims(db, claims)
        finally:
            db.close()

    async def handle_client_message(
        self,
        websocket: WebSocket,
        game_id: int,
        player: int,
        data: Any,
        *,
        session_factory: SessionFactory | None = None,
    ) -> dict[str, Any] | None:
        if not isinstance(data, dict):
            await websocket.send_json(
                error_message(
                    "Realtime messages must be JSON objects",
                    code="invalid_input",
                )
            )
            return None

        action = data.get("action")
        if action is not None and not isinstance(action, str):
            await websocket.send_json(
                error_message("Realtime action must be a string", code="invalid_input")
            )
            return None

        if action == RealtimeClientAction.TIME_EXPIRED:
            return None

        envelope = await self.game_actions.websocket_action(
            action=str(action),
            payload=data,
            game_id=game_id,
            player=player,
            session_factory=session_factory,
        )

        if envelope["type"] == "error":
            await websocket.send_json(envelope)
            return None
        return envelope

    async def broadcast_state(
        self,
        game_id: int,
        game_state: dict[str, Any],
        *,
        result: RealtimeResult | str | None = None,
        completed_round: dict[str, Any] | None = None,
        feedback: dict[str, Any] | None = None,
        only_player: int | None = None,
    ) -> int:
        terminal = is_terminal_result(result, game_state)
        lock = self._broadcast_locks.setdefault(game_id, asyncio.Lock())
        async with lock:
            if terminal:
                self.cancel_timer(game_id)
                self.disconnect_grace_timer.cancel_game(game_id)
            return await self.connections.broadcast(
                game_id,
                state_message(
                    game_state,
                    result=result,
                    completed_round=completed_round,
                    feedback=feedback,
                ),
                only_player=only_player,
                on_disconnect=(
                    None
                    if terminal
                    else lambda failed_player, _websocket: self._start_disconnect_grace(
                        game_id,
                        failed_player,
                    )
                ),
            )

    def disconnect(
        self, game_id: int, player: int, websocket: WebSocket | None = None
    ) -> None:
        removed = self.connections.disconnect(game_id, player, websocket)
        if removed:
            self._start_disconnect_grace(game_id, player)

    def start_timer_from_game(self, game: Any) -> None:
        timer_state = self._timer_state_from_game(game)
        if timer_state is None:
            self.timer.cancel(game.id)
            return
        self.timer.start(
            game.id,
            timer_state.seconds,
            timer_state.current_player,
            timer_state.round_number,
        )

    def start_timer_from_state(self, game_state: dict[str, Any]) -> None:
        timer_state = self._timer_state_from_state(game_state)
        if timer_state is None:
            self.timer.cancel(game_state["id"])
            return
        self.timer.start(
            game_state["id"],
            timer_state.seconds,
            timer_state.current_player,
            timer_state.round_number,
        )

    def cancel_timer(self, game_id: int) -> None:
        self.timer.cancel(game_id)

    def _timer_state_from_game(self, game: Any) -> TurnTimerState | None:
        hook = getattr(self.adapter, "timer_state_from_game", None)
        if hook is not None:
            return hook(game)
        return TurnTimerState(
            seconds=getattr(game, "turn_seconds", None),
            current_player=getattr(game, "current_player", 0),
            round_number=game.round_number,
        )

    def _timer_state_from_state(
        self, game_state: dict[str, Any]
    ) -> TurnTimerState | None:
        hook = getattr(self.adapter, "timer_state_from_state", None)
        if hook is not None:
            return hook(game_state)
        return TurnTimerState(
            seconds=game_state.get("turn_seconds"),
            current_player=game_state.get("current_player", 0),
            round_number=game_state["round_number"],
        )

    def _start_disconnect_grace(self, game_id: int, player: int) -> None:
        if self.connections.has_player(game_id, player):
            return
        if not getattr(self.adapter, "disconnect_forfeit_enabled", False):
            return

        db: Session | None = None
        try:
            db = self.session_factory()
            game = self.adapter.get_game(db, game_id)
            if (
                getattr(game, "mode", None) != "online_friend"
                or getattr(game, "status", None) != "active"
            ):
                return
            eligible_hook = getattr(self.adapter, "disconnect_forfeit_eligible", None)
            if eligible_hook is not None and not eligible_hook(game):
                return
        except GameActionError:
            logger.info(
                "Skipping disconnect grace for missing game %s player %s",
                game_id,
                player,
            )
            return
        except Exception:
            logger.exception(
                "Error checking disconnect grace eligibility for game %s player %s; "
                "starting grace timer conservatively",
                game_id,
                player,
            )
        finally:
            if db is not None:
                db.close()

        self.disconnect_grace_timer.start(
            game_id,
            player,
            self.disconnect_grace_seconds,
        )

    async def _expire_disconnect_grace(self, game_id: int, player: int) -> None:
        if self.connections.has_player(game_id, player):
            return

        async with self.game_actions.game_lock(game_id):
            db = self.session_factory()
            try:
                def action():
                    if self.connections.has_player(game_id, player):
                        return GAME_ACTION_NOOP
                    try:
                        game = self.adapter.get_game(db, game_id)
                    except GameActionError:
                        return GAME_ACTION_NOOP
                    if (
                        getattr(game, "mode", None) != "online_friend"
                        or getattr(game, "status", None) != "active"
                    ):
                        return GAME_ACTION_NOOP
                    eligible_hook = getattr(
                        self.adapter,
                        "disconnect_forfeit_eligible",
                        None,
                    )
                    if eligible_hook is not None and not eligible_hook(game):
                        return GAME_ACTION_NOOP
                    return self.adapter.handle_player_forfeit(
                        db,
                        game,
                        forfeiting_player=player,
                        result=RealtimeResult.OPPONENT_LEFT,
                    )

                game = run_game_action(db, action)
                if game is GAME_ACTION_NOOP:
                    return

                db.refresh(game)
                state = self.adapter.serialize_state(db, game)
            except Exception:
                logger.exception(
                    "Error in realtime disconnect grace timer for game %s player %s",
                    game_id,
                    player,
                )
                return
            finally:
                db.close()

        self.cancel_timer(game_id)
        self.disconnect_grace_timer.cancel_game(game_id)
        await self.broadcast_state(
            game_id,
            state,
            result=RealtimeResult.OPPONENT_LEFT,
        )

    async def _expire_turn(
        self, game_id: int, expected_player: int, expected_round: int
    ) -> None:
        async with self.game_actions.game_lock(game_id):
            db = self.session_factory()
            try:
                def action():
                    try:
                        game = self.adapter.get_game(db, game_id)
                    except GameActionError:
                        return GAME_ACTION_NOOP
                    handle_unattended_time_expired = getattr(
                        self.adapter,
                        "handle_unattended_time_expired",
                        None,
                    )
                    if (
                        handle_unattended_time_expired is not None
                        and not self.connections.has_player(game_id, 1)
                        and not self.connections.has_player(game_id, 2)
                    ):
                        return handle_unattended_time_expired(
                            db,
                            game,
                            expected_player=expected_player,
                            expected_round=expected_round,
                        )
                    return self.adapter.handle_time_expired(
                        db,
                        game,
                        expected_player=expected_player,
                        expected_round=expected_round,
                    )

                game = run_game_action(db, action)
                if game is GAME_ACTION_NOOP:
                    return

                db.refresh(game)
                state = self.adapter.serialize_state(db, game)
            except Exception:
                logger.exception("Error in realtime turn timer for game %s", game_id)
                return
            finally:
                db.close()

        await self.broadcast_state(game_id, state, result=RealtimeResult.TIME_EXPIRED)
        fresh_state = self._fresh_active_state(game_id)
        if fresh_state is not None:
            self.start_timer_from_state(fresh_state)

    def _fresh_active_state(self, game_id: int) -> dict[str, Any] | None:
        db = self.session_factory()
        try:
            game = self.adapter.get_game(db, game_id)
            if getattr(game, "status", None) != "active":
                return None
            return self.adapter.serialize_state(db, game)
        except GameActionError:
            return None
        except Exception:
            logger.exception("Error checking active state for game %s", game_id)
            return None
        finally:
            db.close()


def _websocket_query_param(websocket: WebSocket, name: str) -> str | None:
    query_params = getattr(websocket, "query_params", None)
    if query_params is None or not hasattr(query_params, "get"):
        return None
    value = query_params.get(name)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None
