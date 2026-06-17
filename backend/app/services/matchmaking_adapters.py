from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Mapping

from sqlalchemy import func, or_
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
    ExistingMatchmakingGame,
    MatchmakingCancelRequest,
    MatchmakingRequest,
    MatchmakingStatus,
    clean_guest_id,
    clean_preset,
)


@dataclass(frozen=True)
class TicTacToeMatchmakingPreset:
    target_wins: int = 3
    timer_mode: str = "40s"


@dataclass(frozen=True)
class TicTacToeQuickMatchPoolCounts:
    searching: int = 0
    in_progress: int = 0


TICTACTOE_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS = 5

DEFAULT_TICTACTOE_MATCHMAKING_PRESETS = {
    "blitz": TicTacToeMatchmakingPreset(target_wins=3, timer_mode="15s"),
    "standard": TicTacToeMatchmakingPreset(target_wins=3, timer_mode="40s"),
    "long": TicTacToeMatchmakingPreset(target_wins=5, timer_mode="40s"),
}


class TicTacToeMatchmakingAdapter:
    game_kind = GameKind.TICTACTOE.value

    def __init__(
        self,
        presets: Mapping[str, TicTacToeMatchmakingPreset] | None = None,
    ):
        source = DEFAULT_TICTACTOE_MATCHMAKING_PRESETS if presets is None else presets
        self._presets = {}
        for key, value in source.items():
            preset_key = clean_preset(key)
            self._validate_preset_config(preset_key, value)
            self._presets[preset_key] = value

    def preset_keys(self) -> tuple[str, ...]:
        return tuple(self._presets.keys())

    def pool_presence_counts(
        self,
        db: Session,
    ) -> dict[str, TicTacToeQuickMatchPoolCounts]:
        counts = {
            preset: TicTacToeQuickMatchPoolCounts() for preset in self.preset_keys()
        }
        if not counts:
            return counts

        rows = (
            db.query(
                QuizTicTacToeGame.preset,
                QuizTicTacToeGame.status,
                func.count(QuizTicTacToeGame.id),
            )
            .filter(
                QuizTicTacToeGame.mode == "online_friend",
                QuizTicTacToeGame.is_public.is_(True),
                QuizTicTacToeGame.preset.in_(tuple(counts)),
                QuizTicTacToeGame.status.in_(("waiting_for_opponent", "active")),
            )
            .group_by(QuizTicTacToeGame.preset, QuizTicTacToeGame.status)
            .all()
        )

        for preset, status, total in rows:
            current = counts[preset]
            total_count = int(total or 0)
            if status == "waiting_for_opponent":
                counts[preset] = TicTacToeQuickMatchPoolCounts(
                    searching=total_count,
                    in_progress=current.in_progress,
                )
            elif status == "active":
                counts[preset] = TicTacToeQuickMatchPoolCounts(
                    searching=current.searching,
                    in_progress=total_count,
                )

        return counts

    def find_existing_game(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> ExistingMatchmakingGame | None:
        self._preset_config(request.preset)
        game = (
            db.query(QuizTicTacToeGame)
            .filter(
                QuizTicTacToeGame.mode == "online_friend",
                QuizTicTacToeGame.status.in_(("waiting_for_opponent", "active")),
                QuizTicTacToeGame.is_public.is_(True),
                QuizTicTacToeGame.preset == request.preset,
                or_(
                    QuizTicTacToeGame.player1_guest_id == request.guest_id,
                    QuizTicTacToeGame.player2_guest_id == request.guest_id,
                ),
            )
            .order_by(
                QuizTicTacToeGame.status.asc(),
                QuizTicTacToeGame.created_at.asc(),
                QuizTicTacToeGame.id.asc(),
            )
            .first()
        )
        if game is None:
            return None

        player = 1 if clean_guest_id(game.player1_guest_id) == request.guest_id else 2
        status = (
            MatchmakingStatus.MATCHED
            if game.status == "active"
            else MatchmakingStatus.SEARCHING
        )
        return ExistingMatchmakingGame(status=status, game=game, player=player)

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

    @staticmethod
    def _validate_preset_config(
        preset: str,
        config: TicTacToeMatchmakingPreset,
    ) -> None:
        if config.target_wins not in ttt_service.TARGET_WINS_OPTIONS:
            raise InvalidGameActionError(
                f"Invalid TicTacToe target_wins for preset '{preset}'"
            )
        if config.timer_mode not in ttt_service.TIMER_MODE_TO_SECONDS:
            raise InvalidGameActionError(
                f"Invalid TicTacToe timer_mode for preset '{preset}'"
            )
