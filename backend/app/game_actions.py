"""Transaction and error helpers for game actions."""

from collections.abc import Callable
from enum import StrEnum
from typing import NoReturn, TypeVar

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.schemas.realtime import error_message


class GameActionCode(StrEnum):
    INVALID_INPUT = "invalid_input"
    NOT_FOUND = "not_found"
    CONFLICT = "conflict"
    UNSUPPORTED = "unsupported"
    INTERNAL = "internal"


class GameActionNoop:
    """Marker for a valid action that made no state change."""


GAME_ACTION_NOOP = GameActionNoop()


class GameActionError(Exception):
    """HTTP-agnostic domain error raised by game modules."""

    code = GameActionCode.INVALID_INPUT

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class InvalidGameActionError(GameActionError):
    code = GameActionCode.INVALID_INPUT


class NotFoundGameActionError(GameActionError):
    code = GameActionCode.NOT_FOUND


class ConflictGameActionError(GameActionError):
    code = GameActionCode.CONFLICT


class UnsupportedGameActionError(GameActionError):
    code = GameActionCode.UNSUPPORTED


class InternalGameActionError(GameActionError):
    code = GameActionCode.INTERNAL


_HTTP_STATUS_BY_CODE = {
    GameActionCode.INVALID_INPUT: 400,
    GameActionCode.NOT_FOUND: 404,
    GameActionCode.CONFLICT: 409,
    GameActionCode.UNSUPPORTED: 501,
    GameActionCode.INTERNAL: 500,
}

T = TypeVar("T")


def run_game_action(db: Session, action: Callable[[], T]) -> T:
    """Run one game action on an existing session.

    The caller owns the session lifetime. This helper only owns the transaction:
    commit on success, rollback on domain or unexpected failure, and no commit
    for explicit no-op actions.
    """
    try:
        result = action()
        if result is GAME_ACTION_NOOP:
            db.rollback()
            return result
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise


def http_exception_for_game_action_error(exc: GameActionError) -> HTTPException:
    return HTTPException(
        status_code=_HTTP_STATUS_BY_CODE[exc.code],
        detail=exc.detail,
    )


def raise_http_game_action_error(exc: GameActionError) -> NoReturn:
    raise http_exception_for_game_action_error(exc) from exc


def run_http_game_action(db: Session, action: Callable[[], T]) -> T:
    try:
        return run_game_action(db, action)
    except GameActionError as exc:
        raise_http_game_action_error(exc)


def websocket_error_payload(exc: GameActionError) -> dict:
    return error_message(exc.detail, code=exc.code.value)
