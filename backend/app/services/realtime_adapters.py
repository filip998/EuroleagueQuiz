from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.game_actions import (
    GAME_ACTION_NOOP,
    InvalidGameActionError,
    UnsupportedGameActionError,
)
from app.schemas.realtime import RealtimeClientAction, RealtimeResult
from app.services import career_quiz as career_service
from app.services import roster_guess as roster_service
from app.services import tictactoe as ttt_service
from app.services.game_action_orchestration import (
    GameActionCommand,
    GameActionName,
    RealtimeActionOutcome,
)


_TICTACTOE_ROUND_RESULTS = {"round_won", "round_drawn", "match_won", "board_complete"}
_ROSTER_ROUND_RESULTS = {"round_won", "round_complete", "match_won", "board_complete"}
_CAREER_ROUND_RESULTS = {"round_won", "match_won"}


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


def _required_str(data: dict[str, Any], field: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value:
        raise InvalidGameActionError(f"Missing or invalid game action field: {field}")
    return value


def _required_game_id(game_id: int | None) -> int:
    if not isinstance(game_id, int) or isinstance(game_id, bool):
        raise InvalidGameActionError("Missing or invalid game_id")
    return game_id


def _online_actor(game: Any, player: int | None) -> int | None:
    if game.mode != "online_friend":
        return None
    if player not in (1, 2):
        raise InvalidGameActionError("Online game actions require player identity")
    return player


class TicTacToeRealtimeAdapter:
    disconnect_forfeit_enabled = True
    http_actions = {
        GameActionName.CREATE.value,
        GameActionName.JOIN.value,
        GameActionName.MOVE.value,
        GameActionName.OFFER_DRAW.value,
        GameActionName.RESPOND_DRAW.value,
        GameActionName.GIVE_UP.value,
    }
    websocket_actions = {
        RealtimeClientAction.MOVE.value,
        RealtimeClientAction.OFFER_DRAW.value,
        RealtimeClientAction.RESPOND_DRAW.value,
        RealtimeClientAction.GIVE_UP.value,
    }
    client_actions = websocket_actions

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
        return self._handle_bound_action(db, game, action=action, data=data, player=player)

    def handle_game_action(
        self,
        db: Session,
        command: GameActionCommand,
    ) -> RealtimeActionOutcome:
        data = command.payload
        if command.action == GameActionName.CREATE:
            game = ttt_service.create_game(
                db,
                mode=data.get("mode", "single_player"),
                target_wins=data.get("target_wins", 3),
                timer_mode=data.get("timer_mode", "40s"),
                player1_name=data.get("player1_name"),
                player2_name=data.get("player2_name"),
                guest_id=data.get("guest_id"),
            )
            return RealtimeActionOutcome(game=game, broadcast=False)

        if command.action == GameActionName.JOIN:
            game = ttt_service.join_game(
                db,
                _required_str(data, "join_code").upper(),
                data.get("player_name"),
                guest_id=data.get("guest_id"),
            )
            return RealtimeActionOutcome(game=game, broadcast=True, schedule_timer=True)

        game = self.get_game(db, _required_game_id(command.game_id))
        return self._handle_bound_action(
            db,
            game,
            action=command.action,
            data=data,
            player=command.player,
            source=command.source,
        )

    def _handle_bound_action(
        self,
        db: Session,
        game: Any,
        *,
        action: str,
        data: dict[str, Any],
        player: int | None,
        source: str = "http",
    ) -> RealtimeActionOutcome:
        if action == GameActionName.MOVE:
            acting_player = _online_actor(game, player)
            prev_round_number = game.round_number
            result = ttt_service.submit_move(
                db,
                game=game,
                row_index=_required_int(data, "row_index"),
                col_index=_required_int(data, "col_index"),
                player_id=_required_int(data, "player_id"),
                acting_player=acting_player,
            )
            return RealtimeActionOutcome(
                game=game,
                result=result,
                completed_round_number=(
                    prev_round_number if result in _TICTACTOE_ROUND_RESULTS else None
                ),
                schedule_timer=result != RealtimeResult.MATCH_WON,
                cancel_timer=result == RealtimeResult.MATCH_WON,
            )

        if action == GameActionName.OFFER_DRAW:
            acting_player = _online_actor(game, player)
            ttt_service.offer_draw(db, game, acting_player=acting_player)
            return RealtimeActionOutcome(
                game=game,
                result=RealtimeResult.DRAW_OFFERED,
                schedule_timer=True,
            )

        if action == GameActionName.RESPOND_DRAW:
            acting_player = _online_actor(game, player)
            prev_round_number = game.round_number
            result = ttt_service.respond_draw(
                db,
                game,
                accept=_required_bool(data, "accept"),
                acting_player=acting_player,
            )
            realtime_result = f"draw_{result}"
            return RealtimeActionOutcome(
                game=game,
                result=realtime_result,
                completed_round_number=prev_round_number if result == "accepted" else None,
                schedule_timer=game.status == "active",
                cancel_timer=game.status == "finished",
            )

        if action == GameActionName.GIVE_UP:
            if game.mode == "online_friend":
                acting_player = _online_actor(game, player)
                ttt_service.forfeit_online_game(
                    db,
                    game,
                    forfeiting_player=acting_player,
                )
                return RealtimeActionOutcome(
                    game=game,
                    result=RealtimeResult.RESIGNED,
                    cancel_timer=True,
                )
            if source == "websocket":
                raise UnsupportedGameActionError(
                    "Give up over realtime is only available for online games"
                )
            given_up_round = ttt_service.give_up_round(db, game)
            return RealtimeActionOutcome(
                game=game,
                result=RealtimeResult.GAVE_UP,
                completed_round_number=given_up_round,
                broadcast=False,
            )

        raise AssertionError(f"Unhandled TicTacToe game action: {action}")

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

    def handle_player_forfeit(
        self,
        db: Session,
        game: Any,
        *,
        forfeiting_player: int,
        result: RealtimeResult,
    ) -> Any:
        ttt_service.forfeit_online_game(
            db,
            game,
            forfeiting_player=forfeiting_player,
        )
        return game


class RosterGuessRealtimeAdapter:
    disconnect_forfeit_enabled = False
    http_actions = {
        GameActionName.CREATE.value,
        GameActionName.JOIN.value,
        GameActionName.GUESS.value,
        GameActionName.OFFER_END.value,
        GameActionName.RESPOND_END.value,
        GameActionName.GIVE_UP.value,
    }
    websocket_actions = {
        RealtimeClientAction.GUESS.value,
        RealtimeClientAction.OFFER_END.value,
        RealtimeClientAction.RESPOND_END.value,
    }
    client_actions = websocket_actions

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
        return self._handle_bound_action(db, game, action=action, data=data, player=player)

    def handle_game_action(
        self,
        db: Session,
        command: GameActionCommand,
    ) -> RealtimeActionOutcome:
        data = command.payload
        if command.action == GameActionName.CREATE:
            game = roster_service.create_game(
                db,
                mode=data.get("mode", "single_player"),
                target_wins=data.get("target_wins", 3),
                timer_mode=data.get("timer_mode", "40s"),
                player1_name=data.get("player1_name"),
                player2_name=data.get("player2_name"),
                season_range_start=data.get("season_range_start"),
                season_range_end=data.get("season_range_end"),
                guest_id=data.get("guest_id"),
            )
            return RealtimeActionOutcome(game=game, broadcast=False)

        if command.action == GameActionName.JOIN:
            game = roster_service.join_game(
                db,
                _required_str(data, "join_code").upper(),
                data.get("player_name"),
                guest_id=data.get("guest_id"),
            )
            return RealtimeActionOutcome(game=game, broadcast=True, schedule_timer=True)

        game = self.get_game(db, _required_game_id(command.game_id))
        return self._handle_bound_action(
            db,
            game,
            action=command.action,
            data=data,
            player=command.player,
        )

    def _handle_bound_action(
        self,
        db: Session,
        game: Any,
        *,
        action: str,
        data: dict[str, Any],
        player: int | None,
    ) -> RealtimeActionOutcome:
        if action == GameActionName.GUESS:
            acting_player = _online_actor(game, player)
            prev_round_number = game.round_number
            result = roster_service.submit_guess(
                db,
                game=game,
                player_id=_required_int(data, "player_id"),
                acting_player=acting_player,
            )
            return RealtimeActionOutcome(
                game=game,
                result=result,
                completed_round_number=(
                    prev_round_number if result in _ROSTER_ROUND_RESULTS else None
                ),
                schedule_timer=result != RealtimeResult.MATCH_WON,
                cancel_timer=result == RealtimeResult.MATCH_WON,
            )

        if action == GameActionName.OFFER_END:
            acting_player = _online_actor(game, player)
            roster_service.offer_end(db, game, acting_player=acting_player)
            return RealtimeActionOutcome(
                game=game,
                result=RealtimeResult.END_OFFERED,
                schedule_timer=True,
            )

        if action == GameActionName.RESPOND_END:
            acting_player = _online_actor(game, player)
            prev_round_number = game.round_number
            result = roster_service.respond_end(
                db,
                game,
                accept=_required_bool(data, "accept"),
                acting_player=acting_player,
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

        if action == GameActionName.GIVE_UP:
            given_up_round = roster_service.give_up(db, game)
            return RealtimeActionOutcome(
                game=game,
                result=RealtimeResult.GIVEN_UP,
                completed_round_number=given_up_round,
                broadcast=False,
            )

        raise AssertionError(f"Unhandled Roster Guess game action: {action}")

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

    def handle_player_forfeit(
        self,
        _db: Session,
        _game: Any,
        *,
        forfeiting_player: int,
        result: RealtimeResult,
    ) -> Any:
        return GAME_ACTION_NOOP


class CareerQuizRealtimeAdapter:
    disconnect_forfeit_enabled = False
    http_actions = {
        GameActionName.CREATE.value,
        GameActionName.JOIN.value,
        GameActionName.GUESS.value,
        GameActionName.OFFER_NO_ANSWER.value,
        GameActionName.RESPOND_NO_ANSWER.value,
    }
    websocket_actions = {
        RealtimeClientAction.GUESS.value,
        RealtimeClientAction.OFFER_NO_ANSWER.value,
        RealtimeClientAction.RESPOND_NO_ANSWER.value,
    }
    client_actions = websocket_actions

    def get_game(self, db: Session, game_id: int) -> Any:
        return career_service.get_game_or_404(db, game_id)

    def serialize_state(self, db: Session, game: Any) -> dict[str, Any]:
        return career_service.serialize_game_state(db, game)

    def serialize_completed_round(
        self, db: Session, game_id: int, round_number: int
    ) -> dict[str, Any] | None:
        return career_service.serialize_completed_round(db, game_id, round_number)

    def handle_client_action(
        self,
        db: Session,
        game: Any,
        *,
        action: str,
        data: dict[str, Any],
        player: int,
    ) -> RealtimeActionOutcome:
        return self._handle_bound_action(db, game, action=action, data=data, player=player)

    def handle_game_action(
        self,
        db: Session,
        command: GameActionCommand,
    ) -> RealtimeActionOutcome:
        data = command.payload
        if command.action == GameActionName.CREATE:
            game = career_service.create_game(
                db,
                target_wins=data.get("target_wins", 3),
                wrong_guess_visibility=data.get("wrong_guess_visibility", "private"),
                player1_name=data.get("player1_name"),
                guest_id=data.get("guest_id"),
            )
            return RealtimeActionOutcome(game=game, broadcast=False)

        if command.action == GameActionName.JOIN:
            game = career_service.join_game(
                db,
                _required_str(data, "join_code").upper(),
                player_name=data.get("player_name"),
                guest_id=data.get("guest_id"),
            )
            return RealtimeActionOutcome(game=game, broadcast=True)

        game = self.get_game(db, _required_game_id(command.game_id))
        return self._handle_bound_action(
            db,
            game,
            action=command.action,
            data=data,
            player=command.player,
        )

    def _handle_bound_action(
        self,
        db: Session,
        game: Any,
        *,
        action: str,
        data: dict[str, Any],
        player: int | None,
    ) -> RealtimeActionOutcome:
        if action == GameActionName.GUESS:
            acting_player = _online_actor(game, player)
            prev_round_number = game.round_number
            result = career_service.submit_guess(
                db,
                game=game,
                player_id=_required_int(data, "player_id"),
                acting_player=acting_player,
                round_number=_required_int(data, "round_number"),
            )
            return RealtimeActionOutcome(
                game=game,
                result=result,
                completed_round_number=(
                    prev_round_number if result in _CAREER_ROUND_RESULTS else None
                ),
                broadcast_to_player=(
                    acting_player
                    if result == RealtimeResult.INCORRECT.value
                    and game.wrong_guess_visibility != "shared"
                    else None
                ),
            )

        if action == GameActionName.OFFER_NO_ANSWER:
            acting_player = _online_actor(game, player)
            career_service.offer_no_answer(
                db,
                game=game,
                acting_player=acting_player,
                round_number=_required_int(data, "round_number"),
            )
            return RealtimeActionOutcome(
                game=game,
                result=RealtimeResult.NO_ANSWER_OFFERED,
            )

        if action == GameActionName.RESPOND_NO_ANSWER:
            acting_player = _online_actor(game, player)
            prev_round_number = game.round_number
            result = career_service.respond_no_answer(
                db,
                game=game,
                acting_player=acting_player,
                accept=_required_bool(data, "accept"),
                round_number=_required_int(data, "round_number"),
            )
            return RealtimeActionOutcome(
                game=game,
                result=f"no_answer_{result}",
                completed_round_number=(
                    prev_round_number if result == "accepted" else None
                ),
            )

        raise AssertionError(f"Unhandled Career Quiz game action: {action}")

    def handle_time_expired(
        self,
        db: Session,
        game: Any,
        *,
        expected_player: int,
        expected_round: int,
    ) -> Any:
        return GAME_ACTION_NOOP

    def handle_player_forfeit(
        self,
        _db: Session,
        _game: Any,
        *,
        forfeiting_player: int,
        result: RealtimeResult,
    ) -> Any:
        return GAME_ACTION_NOOP
