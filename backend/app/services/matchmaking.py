"""Generic find-or-create matchmaking for public online game pools.

The lock-based atomicity here assumes one uvicorn worker in one process. If the
backend moves to multiple workers or instances, replace this with a DB-backed
claim/queue so the pool is serialized across processes.
"""

from __future__ import annotations

import asyncio
import random
import threading
import weakref
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Any, Mapping, Protocol

from sqlalchemy.orm import Session

from app.game_actions import InvalidGameActionError, run_game_action

GUEST_ID_MAX_LENGTH = 64
PRESET_MAX_LENGTH = 128


class MatchmakingStatus(StrEnum):
    SEARCHING = "searching"
    MATCHED = "matched"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class MatchmakingRequest:
    preset: str
    player_name: str | None = None
    guest_id: str | None = None
    options: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MatchmakingCancelRequest:
    preset: str
    game_id: int
    guest_id: str | None = None


@dataclass(frozen=True)
class MatchmakingResult:
    status: MatchmakingStatus
    game_kind: str
    preset: str
    game: Any
    player: int | None
    starting_player: int | None = None


class MatchmakingAdapter(Protocol):
    game_kind: str

    def find_waiting_game(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> Any | None: ...

    def create_waiting_game(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> Any: ...

    def join_waiting_game(
        self,
        db: Session,
        game: Any,
        request: MatchmakingRequest,
        *,
        starting_player: int,
    ) -> Any: ...

    def cancel_waiting_game(
        self,
        db: Session,
        request: MatchmakingCancelRequest,
    ) -> Any: ...


PoolKey = tuple[str, str]

_lock_registry_guard = threading.Lock()
_pool_locks_by_loop: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop,
    dict[PoolKey, asyncio.Lock],
] = weakref.WeakKeyDictionary()


def clean_guest_id(guest_id: str | None) -> str | None:
    if not guest_id:
        return None
    cleaned = guest_id.strip()[:GUEST_ID_MAX_LENGTH]
    return cleaned or None


def clean_preset(preset: str) -> str:
    if not isinstance(preset, str):
        raise InvalidGameActionError("preset must be a string")
    cleaned = preset.strip()[:PRESET_MAX_LENGTH]
    if not cleaned:
        raise InvalidGameActionError("preset is required")
    return cleaned


def random_starting_player() -> int:
    return random.choice((1, 2))


async def find_or_create_match(
    db: Session,
    adapter: MatchmakingAdapter,
    request: MatchmakingRequest,
) -> MatchmakingResult:
    normalized = _normalize_request(request)
    game_kind = _adapter_game_kind(adapter)

    async with _pool_lock(game_kind, normalized.preset):
        await asyncio.sleep(0)

        def action() -> MatchmakingResult:
            waiting_game = adapter.find_waiting_game(db, normalized)
            if waiting_game is not None:
                starting_player = random_starting_player()
                game = adapter.join_waiting_game(
                    db,
                    waiting_game,
                    normalized,
                    starting_player=starting_player,
                )
                return MatchmakingResult(
                    status=MatchmakingStatus.MATCHED,
                    game_kind=game_kind,
                    preset=normalized.preset,
                    game=game,
                    player=2,
                    starting_player=starting_player,
                )

            game = adapter.create_waiting_game(db, normalized)
            return MatchmakingResult(
                status=MatchmakingStatus.SEARCHING,
                game_kind=game_kind,
                preset=normalized.preset,
                game=game,
                player=1,
            )

        return run_game_action(db, action)


async def cancel_search(
    db: Session,
    adapter: MatchmakingAdapter,
    request: MatchmakingCancelRequest,
) -> MatchmakingResult:
    normalized = _normalize_cancel_request(request)
    game_kind = _adapter_game_kind(adapter)

    async with _pool_lock(game_kind, normalized.preset):
        await asyncio.sleep(0)

        def action() -> MatchmakingResult:
            game = adapter.cancel_waiting_game(db, normalized)
            return MatchmakingResult(
                status=MatchmakingStatus.CANCELLED,
                game_kind=game_kind,
                preset=normalized.preset,
                game=game,
                player=None,
            )

        return run_game_action(db, action)


def _normalize_request(request: MatchmakingRequest) -> MatchmakingRequest:
    return replace(
        request,
        preset=clean_preset(request.preset),
        guest_id=clean_guest_id(request.guest_id),
    )


def _normalize_cancel_request(
    request: MatchmakingCancelRequest,
) -> MatchmakingCancelRequest:
    if not isinstance(request.game_id, int) or isinstance(request.game_id, bool):
        raise InvalidGameActionError("game_id must be an integer")
    guest_id = clean_guest_id(request.guest_id)
    if guest_id is None:
        raise InvalidGameActionError("guest_id is required to cancel quick match")
    return replace(
        request,
        preset=clean_preset(request.preset),
        guest_id=guest_id,
    )


def _adapter_game_kind(adapter: MatchmakingAdapter) -> str:
    game_kind = str(adapter.game_kind).strip()
    if not game_kind:
        raise InvalidGameActionError("game_kind is required")
    return game_kind


def _pool_lock(game_kind: str, preset: str) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    key = (game_kind, preset)
    with _lock_registry_guard:
        locks = _pool_locks_by_loop.setdefault(loop, {})
        lock = locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            locks[key] = lock
        return lock
