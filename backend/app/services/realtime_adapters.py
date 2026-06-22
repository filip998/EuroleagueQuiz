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
from app.services import photo_quiz as photo_service
from app.services import guess_the_list as guess_the_list_service
from app.services import tictactoe as ttt_service
from app.services.game_action_orchestration import (
    GameActionCommand,
    GameActionName,
    RealtimeActionOutcome,
)
from app.services.matchmaking_adapters import (
    CareerQuizMatchmakingAdapter,
    PhotoQuizMatchmakingAdapter,
)
from app.services.race_rounds import public_round_timer_delay_seconds_from_state
from app.services.realtime import TurnTimerState


_TICTACTOE_ROUND_RESULTS = {"round_won", "round_drawn", "match_won", "board_complete"}
_GUESS_THE_LIST_ROUND_RESULTS = {"round_won", "round_complete", "match_won", "board_complete"}
_CAREER_ROUND_RESULTS = {"round_won", "match_won"}
_PHOTO_ROUND_RESULTS = {"round_won", "match_won"}


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


class GuessTheListRealtimeAdapter:
    disconnect_forfeit_enabled = True
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

    def __init__(self):
        pass

    def disconnect_forfeit_eligible(self, game: Any) -> bool:
        return (
            getattr(game, "mode", None) == "online_friend"
            and getattr(game, "status", None) == "active"
        )

    def get_game(self, db: Session, game_id: int) -> Any:
        return guess_the_list_service.get_game_or_404(db, game_id)

    def serialize_state(self, db: Session, game: Any) -> dict[str, Any]:
        return guess_the_list_service.serialize_game_state(db, game)

    def serialize_completed_round(
        self, db: Session, game_id: int, round_number: int
    ) -> dict[str, Any] | None:
        return guess_the_list_service.serialize_completed_round(db, game_id, round_number)

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
            if data.get("is_race"):
                game = guess_the_list_service.create_race_game(
                    db,
                    target_wins=data.get("target_wins", 2),
                    category_type=data.get("category_type"),
                    player1_name=data.get("player1_name"),
                    season_range_start=data.get("season_range_start"),
                    season_range_end=data.get("season_range_end"),
                    guest_id=data.get("guest_id"),
                )
            else:
                game = guess_the_list_service.create_game(
                    db,
                    mode=data.get("mode", "single_player"),
                    target_wins=data.get("target_wins", 3),
                    timer_mode=data.get("timer_mode", "40s"),
                    category_type=data.get("category_type"),
                    player1_name=data.get("player1_name"),
                    player2_name=data.get("player2_name"),
                    season_range_start=data.get("season_range_start"),
                    season_range_end=data.get("season_range_end"),
                    guest_id=data.get("guest_id"),
                )
            return RealtimeActionOutcome(game=game, broadcast=False)

        if command.action == GameActionName.JOIN:
            if data.get("is_race"):
                game = guess_the_list_service.join_race_game(
                    db,
                    _required_str(data, "join_code").upper(),
                    player_name=data.get("player_name"),
                    guest_id=data.get("guest_id"),
                )
            else:
                game = guess_the_list_service.join_game(
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
            if getattr(game, "is_race", False):
                result = guess_the_list_service.submit_race_claim(
                    db,
                    game=game,
                    player_id=_required_int(data, "player_id"),
                    acting_player=acting_player,
                    round_number=_required_int(data, "round_number"),
                )
            else:
                result = guess_the_list_service.submit_guess(
                    db,
                    game=game,
                    player_id=_required_int(data, "player_id"),
                    acting_player=acting_player,
                )
            return RealtimeActionOutcome(
                game=game,
                result=result,
                completed_round_number=(
                    prev_round_number if result in _GUESS_THE_LIST_ROUND_RESULTS else None
                ),
                schedule_timer=(
                    result in _GUESS_THE_LIST_ROUND_RESULTS
                    if getattr(game, "is_race", False)
                    else result != RealtimeResult.MATCH_WON
                ),
                cancel_timer=result == RealtimeResult.MATCH_WON,
            )

        if action == GameActionName.OFFER_END:
            if getattr(game, "is_race", False):
                raise InvalidGameActionError("End offers are not available in Race mode")
            acting_player = _online_actor(game, player)
            guess_the_list_service.offer_end(db, game, acting_player=acting_player)
            return RealtimeActionOutcome(
                game=game,
                result=RealtimeResult.END_OFFERED,
                schedule_timer=True,
            )

        if action == GameActionName.RESPOND_END:
            if getattr(game, "is_race", False):
                raise InvalidGameActionError("End offers are not available in Race mode")
            acting_player = _online_actor(game, player)
            prev_round_number = game.round_number
            result = guess_the_list_service.respond_end(
                db,
                game,
                accept=_required_bool(data, "accept"),
                acting_player=acting_player,
            )
            return RealtimeActionOutcome(
                game=game,
                result=("end_declined" if result == "declined" else result),
                completed_round_number=(
                    prev_round_number if result in _GUESS_THE_LIST_ROUND_RESULTS else None
                ),
                schedule_timer=game.status == "active",
                cancel_timer=game.status == "finished",
            )

        if action == GameActionName.GIVE_UP:
            if getattr(game, "is_race", False):
                acting_player = _online_actor(game, player)
                forfeited = guess_the_list_service.forfeit_online_game(
                    db,
                    game,
                    forfeiting_player=acting_player,
                )
                if not forfeited:
                    return RealtimeActionOutcome(game=game, broadcast=False)
                return RealtimeActionOutcome(
                    game=game,
                    result=RealtimeResult.RESIGNED,
                    cancel_timer=True,
                )
            given_up_round = guess_the_list_service.give_up(db, game)
            return RealtimeActionOutcome(
                game=game,
                result=RealtimeResult.GIVEN_UP,
                completed_round_number=given_up_round,
                broadcast=False,
            )

        raise AssertionError(f"Unhandled Guess the List game action: {action}")

    def handle_time_expired(
        self,
        db: Session,
        game: Any,
        *,
        expected_player: int,
        expected_round: int,
    ) -> Any:
        if getattr(game, "is_race", False):
            if not guess_the_list_service.handle_race_round_time_expired(
                db,
                game,
                expected_round=expected_round,
            ):
                return GAME_ACTION_NOOP
            return game
        if (
            game.status != "active"
            or game.current_player != expected_player
            or game.round_number != expected_round
        ):
            return GAME_ACTION_NOOP
        guess_the_list_service.handle_time_expired(
            db,
            game,
            expected_player=expected_player,
            expected_round=expected_round,
        )
        return game

    def handle_unattended_time_expired(
        self,
        db: Session,
        game: Any,
        *,
        expected_player: int,
        expected_round: int,
    ) -> Any:
        if getattr(game, "is_race", False):
            if not guess_the_list_service.handle_race_game_unattended_time_expired(
                db,
                game,
                expected_round=expected_round,
            ):
                return GAME_ACTION_NOOP
            return game
        return self.handle_time_expired(
            db,
            game,
            expected_player=expected_player,
            expected_round=expected_round,
        )

    def timer_state_from_game(self, game: Any) -> TurnTimerState | None:
        if getattr(game, "is_race", False):
            delay = guess_the_list_service.race_round_timer_delay_seconds(game)
            if delay is None:
                return None
            return TurnTimerState(
                seconds=delay,
                current_player=0,
                round_number=game.round_number,
            )
        return TurnTimerState(
            seconds=getattr(game, "turn_seconds", None),
            current_player=getattr(game, "current_player", 0),
            round_number=game.round_number,
        )

    def timer_state_from_state(self, game_state: dict[str, Any]) -> TurnTimerState | None:
        if game_state.get("is_race"):
            delay = guess_the_list_service.race_round_timer_delay_seconds_from_state(game_state)
            if delay is None:
                return None
            return TurnTimerState(
                seconds=delay,
                current_player=0,
                round_number=game_state["round_number"],
            )
        return TurnTimerState(
            seconds=game_state.get("turn_seconds"),
            current_player=game_state.get("current_player", 0),
            round_number=game_state["round_number"],
        )

    def handle_player_forfeit(
        self,
        db: Session,
        game: Any,
        *,
        forfeiting_player: int,
        result: RealtimeResult,
    ) -> Any:
        forfeited = guess_the_list_service.forfeit_online_game(
            db,
            game,
            forfeiting_player=forfeiting_player,
        )
        if not forfeited:
            return GAME_ACTION_NOOP
        return game


class CareerQuizRealtimeAdapter:
    disconnect_forfeit_enabled = True
    http_actions = {
        GameActionName.CREATE.value,
        GameActionName.JOIN.value,
        GameActionName.GUESS.value,
        GameActionName.OFFER_NO_ANSWER.value,
        GameActionName.RESPOND_NO_ANSWER.value,
        GameActionName.GIVE_UP.value,
    }
    websocket_actions = {
        RealtimeClientAction.GUESS.value,
        RealtimeClientAction.OFFER_NO_ANSWER.value,
        RealtimeClientAction.RESPOND_NO_ANSWER.value,
    }
    client_actions = websocket_actions

    def __init__(self, matchmaking: CareerQuizMatchmakingAdapter | None = None):
        self.matchmaking = matchmaking or CareerQuizMatchmakingAdapter()

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
                schedule_timer=result == RealtimeResult.ROUND_WON.value,
                cancel_timer=result == RealtimeResult.MATCH_WON.value,
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
                schedule_timer=result == "accepted" and game.status == "active",
            )

        if action == GameActionName.GIVE_UP:
            acting_player = _online_actor(game, player)
            forfeited = career_service.forfeit_online_game(
                db,
                game,
                forfeiting_player=acting_player,
            )
            if not forfeited:
                return RealtimeActionOutcome(game=game, broadcast=False)
            return RealtimeActionOutcome(
                game=game,
                result=RealtimeResult.RESIGNED,
                cancel_timer=True,
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
        if not career_service.handle_public_round_time_expired(
            db,
            game=game,
            expected_round=expected_round,
        ):
            return GAME_ACTION_NOOP
        return game

    def handle_unattended_time_expired(
        self,
        db: Session,
        game: Any,
        *,
        expected_player: int,
        expected_round: int,
    ) -> Any:
        if not career_service.handle_public_game_unattended_time_expired(
            db,
            game=game,
            expected_round=expected_round,
        ):
            return GAME_ACTION_NOOP
        return game

    def timer_state_from_game(self, game: Any) -> TurnTimerState | None:
        round_seconds = self._round_seconds_for_preset(getattr(game, "preset", None))
        if round_seconds is None:
            return None
        delay = career_service.public_round_timer_delay_seconds(
            game,
            round_seconds=round_seconds,
        )
        if delay is None:
            return None
        return TurnTimerState(
            seconds=delay,
            current_player=0,
            round_number=game.round_number,
        )

    def timer_state_from_state(self, game_state: dict[str, Any]) -> TurnTimerState | None:
        round_seconds = self._round_seconds_for_preset(game_state.get("preset"))
        if round_seconds is None:
            return None
        timer_delay = public_round_timer_delay_seconds_from_state(
            game_state,
            round_seconds=round_seconds,
        )
        if timer_delay is None:
            return None
        return TurnTimerState(
            seconds=timer_delay.seconds,
            current_player=0,
            round_number=timer_delay.round_number,
        )

    def _round_seconds_for_preset(self, preset: object) -> int | None:
        if not isinstance(preset, str) or not preset:
            return None
        try:
            return self.matchmaking.round_seconds_for_preset(preset)
        except InvalidGameActionError:
            return None

    def handle_player_forfeit(
        self,
        db: Session,
        game: Any,
        *,
        forfeiting_player: int,
        result: RealtimeResult,
    ) -> Any:
        career_service.forfeit_online_game(db, game, forfeiting_player=forfeiting_player)
        return game


class PhotoQuizRealtimeAdapter:
    disconnect_forfeit_enabled = True
    http_actions = {
        GameActionName.CREATE.value,
        GameActionName.JOIN.value,
        GameActionName.GUESS.value,
        GameActionName.OFFER_NO_ANSWER.value,
        GameActionName.RESPOND_NO_ANSWER.value,
        GameActionName.GIVE_UP.value,
    }
    websocket_actions = {
        RealtimeClientAction.GUESS.value,
        RealtimeClientAction.OFFER_NO_ANSWER.value,
        RealtimeClientAction.RESPOND_NO_ANSWER.value,
    }
    client_actions = websocket_actions

    def __init__(self, matchmaking: PhotoQuizMatchmakingAdapter | None = None):
        self.matchmaking = matchmaking or PhotoQuizMatchmakingAdapter()

    def get_game(self, db: Session, game_id: int) -> Any:
        return photo_service.get_game_or_404(db, game_id)

    def serialize_state(self, db: Session, game: Any) -> dict[str, Any]:
        return photo_service.serialize_game_state(db, game)

    def serialize_completed_round(
        self, db: Session, game_id: int, round_number: int
    ) -> dict[str, Any] | None:
        return photo_service.serialize_completed_round(db, game_id, round_number)

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
            game = photo_service.create_game(
                db,
                target_wins=data.get("target_wins", 3),
                wrong_guess_visibility=data.get("wrong_guess_visibility", "private"),
                player1_name=data.get("player1_name"),
                guest_id=data.get("guest_id"),
            )
            return RealtimeActionOutcome(game=game, broadcast=False)

        if command.action == GameActionName.JOIN:
            game = photo_service.join_game(
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
            result = photo_service.submit_guess(
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
                    prev_round_number if result in _PHOTO_ROUND_RESULTS else None
                ),
                schedule_timer=result == RealtimeResult.ROUND_WON.value,
                cancel_timer=result == RealtimeResult.MATCH_WON.value,
                broadcast_to_player=(
                    acting_player
                    if result == RealtimeResult.INCORRECT.value
                    and game.wrong_guess_visibility != "shared"
                    else None
                ),
            )

        if action == GameActionName.OFFER_NO_ANSWER:
            acting_player = _online_actor(game, player)
            photo_service.offer_no_answer(
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
            result = photo_service.respond_no_answer(
                db,
                game=game,
                acting_player=acting_player,
                accept=_required_bool(data, "accept"),
                round_number=_required_int(data, "round_number"),
                no_answer_offer_version=_required_int(
                    data, "no_answer_offer_version"
                ),
            )
            accepted = result == "accepted"
            return RealtimeActionOutcome(
                game=game,
                result=f"no_answer_{result}",
                completed_round_number=(
                    prev_round_number if accepted else None
                ),
                schedule_timer=accepted and game.status == "active",
            )

        if action == GameActionName.GIVE_UP:
            acting_player = _online_actor(game, player)
            forfeited = photo_service.forfeit_online_game(
                db,
                game,
                forfeiting_player=acting_player,
            )
            if not forfeited:
                return RealtimeActionOutcome(game=game, broadcast=False)
            return RealtimeActionOutcome(
                game=game,
                result=RealtimeResult.RESIGNED,
                cancel_timer=True,
            )

        raise AssertionError(f"Unhandled Photo Quiz game action: {action}")

    def handle_time_expired(
        self,
        db: Session,
        game: Any,
        *,
        expected_player: int,
        expected_round: int,
    ) -> Any:
        if not photo_service.handle_public_round_time_expired(
            db,
            game=game,
            expected_round=expected_round,
        ):
            return GAME_ACTION_NOOP
        return game

    def handle_unattended_time_expired(
        self,
        db: Session,
        game: Any,
        *,
        expected_player: int,
        expected_round: int,
    ) -> Any:
        if not photo_service.handle_public_game_unattended_time_expired(
            db,
            game=game,
            expected_round=expected_round,
        ):
            return GAME_ACTION_NOOP
        return game

    def timer_state_from_game(self, game: Any) -> TurnTimerState | None:
        round_seconds = self._round_seconds_for_preset(getattr(game, "preset", None))
        if round_seconds is None:
            return None
        delay = photo_service.public_round_timer_delay_seconds(
            game,
            round_seconds=round_seconds,
        )
        if delay is None:
            return None
        return TurnTimerState(
            seconds=delay,
            current_player=0,
            round_number=game.round_number,
        )

    def timer_state_from_state(self, game_state: dict[str, Any]) -> TurnTimerState | None:
        round_seconds = self._round_seconds_for_preset(game_state.get("preset"))
        if round_seconds is None:
            return None
        timer_delay = public_round_timer_delay_seconds_from_state(
            game_state,
            round_seconds=round_seconds,
        )
        if timer_delay is None:
            return None
        return TurnTimerState(
            seconds=timer_delay.seconds,
            current_player=0,
            round_number=timer_delay.round_number,
        )

    def _round_seconds_for_preset(self, preset: object) -> int | None:
        if not isinstance(preset, str) or not preset:
            return None
        try:
            return self.matchmaking.round_seconds_for_preset(preset)
        except InvalidGameActionError:
            return None

    def handle_player_forfeit(
        self,
        db: Session,
        game: Any,
        *,
        forfeiting_player: int,
        result: RealtimeResult,
    ) -> Any:
        photo_service.forfeit_online_game(db, game, forfeiting_player=forfeiting_player)
        return game
