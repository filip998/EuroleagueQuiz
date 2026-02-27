"""Server-side turn timer for online Roster Guess games.

Same pattern as timer_manager.py but for the Roster Guess game engine.
"""

import asyncio
import logging
from datetime import datetime

from app.database import SessionLocal
from app.models.roster_guess import RosterGuessGame

logger = logging.getLogger(__name__)

_timers: dict[int, asyncio.Task] = {}


async def _expire_turn(game_id: int, expected_player: int, expected_round: int):
    from app.routers.roster_guess import rg_ws_manager
    from app.services.roster_guess import serialize_game_state, _other_player

    db = SessionLocal()
    try:
        game = db.query(RosterGuessGame).filter(
            RosterGuessGame.id == game_id
        ).first()
        if not game:
            return

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
            logger.exception("Failed to serialize roster-guess game %s after timer expiry", game_id)
            return
        state["last_result"] = "time_expired"
        await rg_ws_manager.broadcast(game_id, state)

        if game.status == "active":
            _schedule_timer(game_id, game.turn_seconds, game.current_player, game.round_number)
    except Exception:
        logger.exception("Error in roster-guess timer for game %s", game_id)
        db.rollback()
    finally:
        db.close()


def _schedule_timer(game_id: int, turn_seconds: int | None, current_player: int, round_number: int):
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
    _schedule_timer(game_id, turn_seconds, current_player, round_number)


def cancel_timer(game_id: int):
    task = _timers.pop(game_id, None)
    if task and not task.done():
        task.cancel()
