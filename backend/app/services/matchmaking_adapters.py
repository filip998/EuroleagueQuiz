from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Mapping

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.game_actions import (
    ConflictGameActionError,
    InvalidGameActionError,
    NotFoundGameActionError,
)
from app.models import QuizTicTacToeGame
from app.services import tictactoe as ttt_service
from app.services.game_action_orchestration import GameKind
from app.services.matchmaking import (
    MatchmakingCancelRequest,
    MatchmakingRequest,
    clean_guest_id,
    clean_preset,
)


@dataclass(frozen=True)
class TicTacToeMatchmakingPreset:
    target_wins: int = 2
    timer_mode: str = "40s"


DEFAULT_TICTACTOE_MATCHMAKING_PRESETS = {
    "standard": TicTacToeMatchmakingPreset(),
}


class TicTacToeMatchmakingAdapter:
    game_kind = GameKind.TICTACTOE.value

    def __init__(
        self,
        presets: Mapping[str, TicTacToeMatchmakingPreset] | None = None,
    ):
        source = DEFAULT_TICTACTOE_MATCHMAKING_PRESETS if presets is None else presets
        self._presets = {clean_preset(key): value for key, value in source.items()}

    def find_existing_search(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> QuizTicTacToeGame | None:
        self._preset_config(request.preset)
        return (
            db.query(QuizTicTacToeGame)
            .filter(
                QuizTicTacToeGame.mode == "online_friend",
                QuizTicTacToeGame.status == "waiting_for_opponent",
                QuizTicTacToeGame.is_public.is_(True),
                QuizTicTacToeGame.preset == request.preset,
                QuizTicTacToeGame.player1_guest_id == request.guest_id,
            )
            .order_by(
                QuizTicTacToeGame.created_at.asc(),
                QuizTicTacToeGame.id.asc(),
            )
            .first()
        )

    def find_waiting_game(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> QuizTicTacToeGame | None:
        self._preset_config(request.preset)
        query = db.query(QuizTicTacToeGame).filter(
            QuizTicTacToeGame.mode == "online_friend",
            QuizTicTacToeGame.status == "waiting_for_opponent",
            QuizTicTacToeGame.is_public.is_(True),
            QuizTicTacToeGame.preset == request.preset,
        )
        if request.guest_id is not None:
            query = query.filter(
                or_(
                    QuizTicTacToeGame.player1_guest_id.is_(None),
                    QuizTicTacToeGame.player1_guest_id != request.guest_id,
                )
            )
        return query.order_by(
            QuizTicTacToeGame.created_at.asc(),
            QuizTicTacToeGame.id.asc(),
        ).first()

    def create_waiting_game(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> QuizTicTacToeGame:
        preset = self._preset_config(request.preset)
        game = ttt_service.create_game(
            db,
            mode="online_friend",
            target_wins=preset.target_wins,
            timer_mode=preset.timer_mode,
            player1_name=request.player_name,
            guest_id=request.guest_id,
        )
        game.is_public = True
        game.preset = request.preset
        game.updated_at = datetime.utcnow()
        db.flush()
        return game

    def join_waiting_game(
        self,
        db: Session,
        game: QuizTicTacToeGame,
        request: MatchmakingRequest,
        *,
        starting_player: int,
    ) -> QuizTicTacToeGame:
        if starting_player not in (1, 2):
            raise InvalidGameActionError("starting_player must be 1 or 2")
        if (
            game.mode != "online_friend"
            or game.status != "waiting_for_opponent"
            or not game.is_public
            or game.preset != request.preset
        ):
            raise ConflictGameActionError("Matchmaking game is no longer available")
        if (
            request.guest_id is not None
            and clean_guest_id(game.player1_guest_id) == request.guest_id
        ):
            raise ConflictGameActionError("Cannot match a game created by the same guest")
        return ttt_service.join_game(
            db,
            game.join_code,
            request.player_name,
            guest_id=request.guest_id,
            started_by_player=starting_player,
        )

    def cancel_waiting_game(
        self,
        db: Session,
        request: MatchmakingCancelRequest,
    ) -> QuizTicTacToeGame:
        self._preset_config(request.preset)
        game = (
            db.query(QuizTicTacToeGame)
            .filter(
                QuizTicTacToeGame.id == request.game_id,
                QuizTicTacToeGame.mode == "online_friend",
                QuizTicTacToeGame.status == "waiting_for_opponent",
                QuizTicTacToeGame.is_public.is_(True),
                QuizTicTacToeGame.preset == request.preset,
            )
            .first()
        )
        if game is None:
            raise NotFoundGameActionError("Matchmaking search not found")
        if clean_guest_id(game.player1_guest_id) != request.guest_id:
            raise ConflictGameActionError("Cannot cancel another player's search")

        db.delete(game)
        db.flush()
        return game

    def _preset_config(self, preset: str) -> TicTacToeMatchmakingPreset:
        try:
            return self._presets[preset]
        except KeyError as exc:
            raise InvalidGameActionError("Unknown TicTacToe matchmaking preset") from exc
