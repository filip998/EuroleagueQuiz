"""Server-side turn timer for online TicTacToe games.

Uses asyncio tasks to enforce turn time limits. When a timer expires,
the server switches the turn and broadcasts to both players — no client
cooperation needed.
"""

import asyncio
import logging
from datetime import datetime

from app.database import SessionLocal
from app.models.tictactoe import QuizTicTacToeGame

logger = logging.getLogger(__name__)

# {game_id: asyncio.Task}
_timers: dict[int, asyncio.Task] = {}


async def _expire_turn(game_id: int, expected_player: int, expected_round: int):
    """Callback when a turn timer fires. Switches the turn if still valid."""
    from app.routers.quiz import ws_manager
    from app.services.tictactoe import serialize_game_state, _other_player

    db = SessionLocal()
    try:
        game = db.query(QuizTicTacToeGame).filter(
            QuizTicTacToeGame.id == game_id
        ).first()
        if not game:
            return

        # Only act if the turn hasn't already changed (prevents races)
        if (
            game.status != "active"
            or game.current_player != expected_player
            or game.round_number != expected_round
        ):
            return

        game.current_player = _other_player(expected_player)
        now = datetime.utcnow()
        game.turn_started_at = now
        game.updated_at = now
        db.commit()
        db.refresh(game)

        try:
            state = serialize_game_state(db, game)
        except Exception:
            logger.exception("Failed to serialize game %s after timer expiry", game_id)
            return
        state["last_result"] = "time_expired"
        await ws_manager.broadcast(game_id, state)

        # Start timer for the next player's turn (only if game is still active)
        if game.status == "active":
            _schedule_timer(game_id, game.turn_seconds, game.current_player, game.round_number)
    except Exception:
        logger.exception("Error in turn timer for game %s", game_id)
        db.rollback()
    finally:
        db.close()


def _schedule_timer(game_id: int, turn_seconds: int | None, current_player: int, round_number: int):
    """Schedule a new turn timer, cancelling any existing one for this game."""
    cancel_timer(game_id)

    if not turn_seconds:
        return

    async def _run():
        await asyncio.sleep(turn_seconds)
        await _expire_turn(game_id, current_player, round_number)

    try:
        loop = asyncio.get_running_loop()
        _timers[game_id] = loop.create_task(_run())
    except RuntimeError:
        pass


def start_turn_timer(game_id: int, turn_seconds: int | None, current_player: int, round_number: int):
    """Public API: start a turn timer for an online game."""
    _schedule_timer(game_id, turn_seconds, current_player, round_number)


def cancel_timer(game_id: int):
    """Cancel any running timer for a game."""
    task = _timers.pop(game_id, None)
    if task and not task.done():
        task.cancel()
