from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.game_actions import GAME_ACTION_NOOP, InvalidGameActionError
from app.schemas.realtime import RealtimeClientAction
from app.services import roster_guess as roster_service
from app.services import tictactoe as ttt_service
from app.services.realtime import RealtimeActionOutcome


_TICTACTOE_ROUND_RESULTS = {"round_won", "round_drawn", "match_won", "board_complete"}
_ROSTER_ROUND_RESULTS = {"round_won", "round_complete", "match_won", "board_complete"}


def _required_int(data: dict[str, Any], field: str) -> int:
    value = data.get(field)
    if not isinstance(value, int) or isinstance(value, bool):
        raise InvalidGameActionError(f"Missing or invalid realtime field: {field}")
    return value


def _required_bool(data: dict[str, Any], field: str) -> bool:
    value = data.get(field)
    if not isinstance(value, bool):
        raise InvalidGameActionError(f"Missing or invalid realtime field: {field}")
    return value


class TicTacToeRealtimeAdapter:
    client_actions = {
        RealtimeClientAction.MOVE.value,
        RealtimeClientAction.OFFER_DRAW.value,
        RealtimeClientAction.RESPOND_DRAW.value,
    }

    def get_game(self, db: Session, game_id: int) -> Any:
        return ttt_service.get_game_or_404(db, game_id)

    def serialize_state(self, db: Session, game: Any) -> dict[str, Any]:
        return ttt_service.serialize_game_state(db, game)

    def serialize_completed_round(
        self, db: Session, game_id: int, round_number: int
    ) -> dict[str, Any] | None:
        return ttt_service.serialize_completed_round(db, game_id, round_number)

    def handle_client_action(
        self,
        db: Session,
        game: Any,
        *,
        action: str,
        data: dict[str, Any],
        player: int,
    ) -> RealtimeActionOutcome:
        if action == RealtimeClientAction.MOVE:
            prev_round_number = game.round_number
            result = ttt_service.submit_move(
                db,
                game=game,
                row_index=_required_int(data, "row_index"),
                col_index=_required_int(data, "col_index"),
                player_id=_required_int(data, "player_id"),
                acting_player=player,
            )
            return RealtimeActionOutcome(
                game=game,
                result=result,
                completed_round_number=(
                    prev_round_number if result in _TICTACTOE_ROUND_RESULTS else None
                ),
                schedule_timer=result != "match_won",
                cancel_timer=result == "match_won",
            )

        if action == RealtimeClientAction.OFFER_DRAW:
            ttt_service.offer_draw(db, game, acting_player=player)
            return RealtimeActionOutcome(game=game, schedule_timer=True)

        if action == RealtimeClientAction.RESPOND_DRAW:
            prev_round_number = game.round_number
            result = ttt_service.respond_draw(
                db,
                game,
                accept=_required_bool(data, "accept"),
                acting_player=player,
            )
            return RealtimeActionOutcome(
                game=game,
                result=f"draw_{result}",
                completed_round_number=prev_round_number if result == "accepted" else None,
                schedule_timer=game.status == "active",
                cancel_timer=game.status == "finished",
            )

        raise AssertionError(f"Unhandled TicTacToe realtime action: {action}")

    def handle_time_expired(
        self,
        db: Session,
        game: Any,
        *,
        expected_player: int,
        expected_round: int,
    ) -> Any:
        if (
            game.status != "active"
            or game.current_player != expected_player
            or game.round_number != expected_round
        ):
            return GAME_ACTION_NOOP
        ttt_service.handle_time_expired(
            db,
            game,
            expected_player=expected_player,
            expected_round=expected_round,
        )
        return game


class RosterGuessRealtimeAdapter:
    client_actions = {
        RealtimeClientAction.GUESS.value,
        RealtimeClientAction.OFFER_END.value,
        RealtimeClientAction.RESPOND_END.value,
    }

    def get_game(self, db: Session, game_id: int) -> Any:
        return roster_service.get_game_or_404(db, game_id)

    def serialize_state(self, db: Session, game: Any) -> dict[str, Any]:
        return roster_service.serialize_game_state(db, game)

    def serialize_completed_round(
        self, db: Session, game_id: int, round_number: int
    ) -> dict[str, Any] | None:
        return roster_service.serialize_completed_round(db, game_id, round_number)

    def handle_client_action(
        self,
        db: Session,
        game: Any,
        *,
        action: str,
        data: dict[str, Any],
        player: int,
    ) -> RealtimeActionOutcome:
        if action == RealtimeClientAction.GUESS:
            prev_round_number = game.round_number
            result = roster_service.submit_guess(
                db,
                game=game,
                player_id=_required_int(data, "player_id"),
                acting_player=player,
            )
            return RealtimeActionOutcome(
                game=game,
                result=result,
                completed_round_number=(
                    prev_round_number if result in _ROSTER_ROUND_RESULTS else None
                ),
                schedule_timer=result != "match_won",
                cancel_timer=result == "match_won",
            )

        if action == RealtimeClientAction.OFFER_END:
            roster_service.offer_end(db, game, acting_player=player)
            return RealtimeActionOutcome(game=game, schedule_timer=True)

        if action == RealtimeClientAction.RESPOND_END:
            prev_round_number = game.round_number
            result = roster_service.respond_end(
                db,
                game,
                accept=_required_bool(data, "accept"),
                acting_player=player,
            )
            return RealtimeActionOutcome(
                game=game,
                result=("end_declined" if result == "declined" else result),
                completed_round_number=(
                    prev_round_number if result in _ROSTER_ROUND_RESULTS else None
                ),
                schedule_timer=game.status == "active",
                cancel_timer=game.status == "finished",
            )

        raise AssertionError(f"Unhandled Roster Guess realtime action: {action}")

    def handle_time_expired(
        self,
        db: Session,
        game: Any,
        *,
        expected_player: int,
        expected_round: int,
    ) -> Any:
        if (
            game.status != "active"
            or game.current_player != expected_player
            or game.round_number != expected_round
        ):
            return GAME_ACTION_NOOP
        roster_service.handle_time_expired(
            db,
            game,
            expected_player=expected_player,
            expected_round=expected_round,
        )
        return game
