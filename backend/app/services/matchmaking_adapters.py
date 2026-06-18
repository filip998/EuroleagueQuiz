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
from app.models import PhotoQuizGame, QuizTicTacToeGame, RosterGuessGame
from app.services import photo_quiz as photo_service
from app.services import roster_guess as roster_service
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


@dataclass(frozen=True)
class PhotoQuizMatchmakingPreset:
    target_wins: int
    wrong_guess_visibility: str = "private"
    round_seconds: int = 10


@dataclass(frozen=True)
class RosterGuessMatchmakingPreset:
    target_wins: int
    season_range_start: int
    season_range_end: int
    round_seconds: int = roster_service.RACE_ROUND_SECONDS
    reveal_seconds: int = roster_service.RACE_REVEAL_SECONDS


@dataclass(frozen=True)
class PhotoQuizQuickMatchPoolCounts:
    searching: int = 0
    in_progress: int = 0


@dataclass(frozen=True)
class RosterGuessQuickMatchPoolCounts:
    searching: int = 0
    in_progress: int = 0


TICTACTOE_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS = 5
PHOTO_QUIZ_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS = 5
ROSTER_GUESS_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS = 5

DEFAULT_TICTACTOE_MATCHMAKING_PRESETS = {
    "blitz": TicTacToeMatchmakingPreset(target_wins=3, timer_mode="15s"),
    "standard": TicTacToeMatchmakingPreset(target_wins=3, timer_mode="40s"),
    "long": TicTacToeMatchmakingPreset(target_wins=5, timer_mode="40s"),
}

DEFAULT_PHOTO_QUIZ_MATCHMAKING_PRESETS = {
    "quick": PhotoQuizMatchmakingPreset(target_wins=1),
    "standard": PhotoQuizMatchmakingPreset(target_wins=3),
    "long": PhotoQuizMatchmakingPreset(target_wins=5),
}

_ROSTER_GUESS_ERA_RANGES = {
    "full": (2000, 2025),
    "modern": (2018, 2025),
    "nostalgia": (2000, 2010),
    "recent": (2010, 2025),
}
_ROSTER_GUESS_LENGTH_TARGETS = {
    "quick": 1,
    "standard": 3,
    "long": 5,
}
DEFAULT_ROSTER_GUESS_MATCHMAKING_PRESETS = {
    f"{era}-{length}": RosterGuessMatchmakingPreset(
        target_wins=target_wins,
        season_range_start=season_start,
        season_range_end=season_end,
    )
    for era, (season_start, season_end) in _ROSTER_GUESS_ERA_RANGES.items()
    for length, target_wins in _ROSTER_GUESS_LENGTH_TARGETS.items()
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


class PhotoQuizMatchmakingAdapter:
    game_kind = GameKind.PHOTO_QUIZ.value

    def __init__(
        self,
        presets: Mapping[str, PhotoQuizMatchmakingPreset] | None = None,
    ):
        source = DEFAULT_PHOTO_QUIZ_MATCHMAKING_PRESETS if presets is None else presets
        self._presets = {}
        for key, value in source.items():
            preset_key = clean_preset(key)
            self._validate_preset_config(preset_key, value)
            self._presets[preset_key] = value

    def preset_keys(self) -> tuple[str, ...]:
        return tuple(self._presets.keys())

    def round_seconds_for_preset(self, preset: str) -> int:
        return self._preset_config(preset).round_seconds

    def pool_presence_counts(
        self,
        db: Session,
    ) -> dict[str, PhotoQuizQuickMatchPoolCounts]:
        counts = {
            preset: PhotoQuizQuickMatchPoolCounts() for preset in self.preset_keys()
        }
        if not counts:
            return counts

        rows = (
            db.query(
                PhotoQuizGame.preset,
                PhotoQuizGame.status,
                func.count(PhotoQuizGame.id),
            )
            .filter(
                PhotoQuizGame.mode == "online_friend",
                PhotoQuizGame.is_public.is_(True),
                PhotoQuizGame.preset.in_(tuple(counts)),
                PhotoQuizGame.status.in_(("waiting_for_opponent", "active")),
            )
            .group_by(PhotoQuizGame.preset, PhotoQuizGame.status)
            .all()
        )

        for preset, status, total in rows:
            current = counts[preset]
            total_count = int(total or 0)
            if status == "waiting_for_opponent":
                counts[preset] = PhotoQuizQuickMatchPoolCounts(
                    searching=total_count,
                    in_progress=current.in_progress,
                )
            elif status == "active":
                counts[preset] = PhotoQuizQuickMatchPoolCounts(
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
            db.query(PhotoQuizGame)
            .filter(
                PhotoQuizGame.mode == "online_friend",
                PhotoQuizGame.status.in_(("waiting_for_opponent", "active")),
                PhotoQuizGame.is_public.is_(True),
                PhotoQuizGame.preset == request.preset,
                or_(
                    PhotoQuizGame.player1_guest_id == request.guest_id,
                    PhotoQuizGame.player2_guest_id == request.guest_id,
                ),
            )
            .order_by(
                PhotoQuizGame.status.asc(),
                PhotoQuizGame.created_at.asc(),
                PhotoQuizGame.id.asc(),
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
    ) -> PhotoQuizGame | None:
        self._preset_config(request.preset)
        query = db.query(PhotoQuizGame).filter(
            PhotoQuizGame.mode == "online_friend",
            PhotoQuizGame.status == "waiting_for_opponent",
            PhotoQuizGame.is_public.is_(True),
            PhotoQuizGame.preset == request.preset,
        )
        if request.guest_id is not None:
            query = query.filter(
                or_(
                    PhotoQuizGame.player1_guest_id.is_(None),
                    PhotoQuizGame.player1_guest_id != request.guest_id,
                )
            )
        return query.order_by(
            PhotoQuizGame.created_at.asc(),
            PhotoQuizGame.id.asc(),
        ).first()

    def create_waiting_game(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> PhotoQuizGame:
        preset = self._preset_config(request.preset)
        game = photo_service.create_game(
            db,
            target_wins=preset.target_wins,
            wrong_guess_visibility=preset.wrong_guess_visibility,
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
        game: PhotoQuizGame,
        request: MatchmakingRequest,
        *,
        starting_player: int,
    ) -> PhotoQuizGame:
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
        return photo_service.join_game(
            db,
            game.join_code,
            player_name=request.player_name,
            guest_id=request.guest_id,
            allow_public=True,
        )

    def cancel_waiting_game(
        self,
        db: Session,
        request: MatchmakingCancelRequest,
    ) -> PhotoQuizGame:
        self._preset_config(request.preset)
        game = (
            db.query(PhotoQuizGame)
            .filter(
                PhotoQuizGame.id == request.game_id,
                PhotoQuizGame.mode == "online_friend",
                PhotoQuizGame.status == "waiting_for_opponent",
                PhotoQuizGame.is_public.is_(True),
                PhotoQuizGame.preset == request.preset,
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

    def _preset_config(self, preset: str) -> PhotoQuizMatchmakingPreset:
        try:
            return self._presets[preset]
        except KeyError as exc:
            raise InvalidGameActionError("Unknown Photo Quiz matchmaking preset") from exc

    @staticmethod
    def _validate_preset_config(
        preset: str,
        config: PhotoQuizMatchmakingPreset,
    ) -> None:
        if config.target_wins not in photo_service.VALID_TARGET_WINS:
            raise InvalidGameActionError(
                f"Invalid Photo Quiz target_wins for preset '{preset}'"
            )
        if config.wrong_guess_visibility not in photo_service.VALID_WRONG_GUESS_VISIBILITY:
            raise InvalidGameActionError(
                f"Invalid Photo Quiz wrong_guess_visibility for preset '{preset}'"
            )
        if not isinstance(config.round_seconds, int) or config.round_seconds <= 0:
            raise InvalidGameActionError(
                f"Invalid Photo Quiz round_seconds for preset '{preset}'"
            )


class RosterGuessMatchmakingAdapter:
    game_kind = GameKind.ROSTER_GUESS.value

    def __init__(
        self,
        presets: Mapping[str, RosterGuessMatchmakingPreset] | None = None,
    ):
        source = DEFAULT_ROSTER_GUESS_MATCHMAKING_PRESETS if presets is None else presets
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
    ) -> dict[str, RosterGuessQuickMatchPoolCounts]:
        counts = {
            preset: RosterGuessQuickMatchPoolCounts() for preset in self.preset_keys()
        }
        if not counts:
            return counts

        rows = (
            db.query(
                RosterGuessGame.preset,
                RosterGuessGame.status,
                func.count(RosterGuessGame.id),
            )
            .filter(
                RosterGuessGame.mode == "online_friend",
                RosterGuessGame.game_type == roster_service.GAME_TYPE_RACE,
                RosterGuessGame.is_public.is_(True),
                RosterGuessGame.preset.in_(tuple(counts)),
                RosterGuessGame.status.in_(("waiting_for_opponent", "active")),
            )
            .group_by(RosterGuessGame.preset, RosterGuessGame.status)
            .all()
        )

        for preset, status, total in rows:
            current = counts[preset]
            total_count = int(total or 0)
            if status == "waiting_for_opponent":
                counts[preset] = RosterGuessQuickMatchPoolCounts(
                    searching=total_count,
                    in_progress=current.in_progress,
                )
            elif status == "active":
                counts[preset] = RosterGuessQuickMatchPoolCounts(
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
            db.query(RosterGuessGame)
            .filter(
                RosterGuessGame.mode == "online_friend",
                RosterGuessGame.game_type == roster_service.GAME_TYPE_RACE,
                RosterGuessGame.status.in_(("waiting_for_opponent", "active")),
                RosterGuessGame.is_public.is_(True),
                RosterGuessGame.preset == request.preset,
                or_(
                    RosterGuessGame.player1_guest_id == request.guest_id,
                    RosterGuessGame.player2_guest_id == request.guest_id,
                ),
            )
            .order_by(
                RosterGuessGame.status.asc(),
                RosterGuessGame.created_at.asc(),
                RosterGuessGame.id.asc(),
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
    ) -> RosterGuessGame | None:
        self._preset_config(request.preset)
        query = db.query(RosterGuessGame).filter(
            RosterGuessGame.mode == "online_friend",
            RosterGuessGame.game_type == roster_service.GAME_TYPE_RACE,
            RosterGuessGame.status == "waiting_for_opponent",
            RosterGuessGame.is_public.is_(True),
            RosterGuessGame.preset == request.preset,
        )
        if request.guest_id is not None:
            query = query.filter(
                or_(
                    RosterGuessGame.player1_guest_id.is_(None),
                    RosterGuessGame.player1_guest_id != request.guest_id,
                )
            )
        return query.order_by(
            RosterGuessGame.created_at.asc(),
            RosterGuessGame.id.asc(),
        ).first()

    def create_waiting_game(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> RosterGuessGame:
        preset = self._preset_config(request.preset)
        return roster_service.create_race_game(
            db,
            target_wins=preset.target_wins,
            player1_name=request.player_name,
            season_range_start=preset.season_range_start,
            season_range_end=preset.season_range_end,
            guest_id=request.guest_id,
            is_public=True,
            preset=request.preset,
            round_seconds=preset.round_seconds,
            reveal_seconds=preset.reveal_seconds,
        )

    def join_waiting_game(
        self,
        db: Session,
        game: RosterGuessGame,
        request: MatchmakingRequest,
        *,
        starting_player: int,
    ) -> RosterGuessGame:
        if (
            game.mode != "online_friend"
            or game.game_type != roster_service.GAME_TYPE_RACE
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
        return roster_service.join_game(
            db,
            game.join_code,
            player2_name=request.player_name,
            guest_id=request.guest_id,
            allow_public=True,
        )

    def cancel_waiting_game(
        self,
        db: Session,
        request: MatchmakingCancelRequest,
    ) -> RosterGuessGame:
        self._preset_config(request.preset)
        game = (
            db.query(RosterGuessGame)
            .filter(
                RosterGuessGame.id == request.game_id,
                RosterGuessGame.mode == "online_friend",
                RosterGuessGame.game_type == roster_service.GAME_TYPE_RACE,
                RosterGuessGame.status == "waiting_for_opponent",
                RosterGuessGame.is_public.is_(True),
                RosterGuessGame.preset == request.preset,
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

    def _preset_config(self, preset: str) -> RosterGuessMatchmakingPreset:
        try:
            return self._presets[preset]
        except KeyError as exc:
            raise InvalidGameActionError("Unknown Roster Guess matchmaking preset") from exc

    @staticmethod
    def _validate_preset_config(
        preset: str,
        config: RosterGuessMatchmakingPreset,
    ) -> None:
        if config.target_wins not in roster_service.RACE_TARGET_WINS_OPTIONS:
            raise InvalidGameActionError(
                f"Invalid Roster Guess target_wins for preset '{preset}'"
            )
        if config.season_range_start > config.season_range_end:
            raise InvalidGameActionError(
                f"Invalid Roster Guess season range for preset '{preset}'"
            )
        if config.round_seconds <= 0:
            raise InvalidGameActionError(
                f"Invalid Roster Guess round_seconds for preset '{preset}'"
            )
        if config.reveal_seconds < 0:
            raise InvalidGameActionError(
                f"Invalid Roster Guess reveal_seconds for preset '{preset}'"
            )
