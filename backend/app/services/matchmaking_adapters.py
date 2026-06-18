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
from app.models import CareerQuizGame, PhotoQuizGame, QuizTicTacToeGame, GuessTheListGame
from app.services import career_quiz as career_service
from app.services import photo_quiz as photo_service
from app.services import guess_the_list as guess_the_list_service
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
class PhotoQuizQuickMatchPoolCounts:
    searching: int = 0
    in_progress: int = 0


@dataclass(frozen=True)
class CareerQuizMatchmakingPreset:
    target_wins: int
    wrong_guess_visibility: str = "private"
    round_seconds: int = 20


@dataclass(frozen=True)
class CareerQuizQuickMatchPoolCounts:
    searching: int = 0
    in_progress: int = 0


@dataclass(frozen=True)
class GuessTheListMatchmakingPreset:
    target_wins: int
    season_range_start: int
    season_range_end: int
    round_seconds: int = guess_the_list_service.RACE_ROUND_SECONDS
    reveal_seconds: int = guess_the_list_service.RACE_REVEAL_SECONDS


@dataclass(frozen=True)
class GuessTheListQuickMatchPoolCounts:
    searching: int = 0
    in_progress: int = 0


TICTACTOE_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS = 5
PHOTO_QUIZ_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS = 5
CAREER_QUIZ_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS = 5
GUESS_THE_LIST_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS = 5

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

DEFAULT_CAREER_QUIZ_MATCHMAKING_PRESETS = {
    "quick": CareerQuizMatchmakingPreset(target_wins=1),
    "standard": CareerQuizMatchmakingPreset(target_wins=3),
    "long": CareerQuizMatchmakingPreset(target_wins=5),
}

_GUESS_THE_LIST_QUICK_MATCH_SEASON_RANGE = (2000, 2025)
_GUESS_THE_LIST_LENGTHS = {
    "quick": 1,
    "standard": 2,
    "long": 3,
}
DEFAULT_GUESS_THE_LIST_MATCHMAKING_PRESETS = {
    length: GuessTheListMatchmakingPreset(
        target_wins=target_wins,
        season_range_start=_GUESS_THE_LIST_QUICK_MATCH_SEASON_RANGE[0],
        season_range_end=_GUESS_THE_LIST_QUICK_MATCH_SEASON_RANGE[1],
    )
    for length, target_wins in _GUESS_THE_LIST_LENGTHS.items()
}
_LEGACY_GUESS_THE_LIST_MATCHMAKING_PRESET_KEYS = frozenset(
    (
        "full-quick",
        "full-standard",
        "full-long",
        "modern-quick",
        "modern-standard",
        "modern-long",
        "nostalgia-quick",
        "nostalgia-standard",
        "nostalgia-long",
        "recent-quick",
        "recent-standard",
        "recent-long",
    )
)


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


class CareerQuizMatchmakingAdapter:
    game_kind = GameKind.CAREER_QUIZ.value

    def __init__(
        self,
        presets: Mapping[str, CareerQuizMatchmakingPreset] | None = None,
    ):
        source = DEFAULT_CAREER_QUIZ_MATCHMAKING_PRESETS if presets is None else presets
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
    ) -> dict[str, CareerQuizQuickMatchPoolCounts]:
        counts = {
            preset: CareerQuizQuickMatchPoolCounts() for preset in self.preset_keys()
        }
        if not counts:
            return counts

        rows = (
            db.query(
                CareerQuizGame.preset,
                CareerQuizGame.status,
                func.count(CareerQuizGame.id),
            )
            .filter(
                CareerQuizGame.mode == "online_friend",
                CareerQuizGame.is_public.is_(True),
                CareerQuizGame.preset.in_(tuple(counts)),
                CareerQuizGame.status.in_(("waiting_for_opponent", "active")),
            )
            .group_by(CareerQuizGame.preset, CareerQuizGame.status)
            .all()
        )

        for preset, status, total in rows:
            current = counts[preset]
            total_count = int(total or 0)
            if status == "waiting_for_opponent":
                counts[preset] = CareerQuizQuickMatchPoolCounts(
                    searching=total_count,
                    in_progress=current.in_progress,
                )
            elif status == "active":
                counts[preset] = CareerQuizQuickMatchPoolCounts(
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
            db.query(CareerQuizGame)
            .filter(
                CareerQuizGame.mode == "online_friend",
                CareerQuizGame.status.in_(("waiting_for_opponent", "active")),
                CareerQuizGame.is_public.is_(True),
                CareerQuizGame.preset == request.preset,
                or_(
                    CareerQuizGame.player1_guest_id == request.guest_id,
                    CareerQuizGame.player2_guest_id == request.guest_id,
                ),
            )
            .order_by(
                CareerQuizGame.status.asc(),
                CareerQuizGame.created_at.asc(),
                CareerQuizGame.id.asc(),
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
    ) -> CareerQuizGame | None:
        self._preset_config(request.preset)
        query = db.query(CareerQuizGame).filter(
            CareerQuizGame.mode == "online_friend",
            CareerQuizGame.status == "waiting_for_opponent",
            CareerQuizGame.is_public.is_(True),
            CareerQuizGame.preset == request.preset,
        )
        if request.guest_id is not None:
            query = query.filter(
                or_(
                    CareerQuizGame.player1_guest_id.is_(None),
                    CareerQuizGame.player1_guest_id != request.guest_id,
                )
            )
        return query.order_by(
            CareerQuizGame.created_at.asc(),
            CareerQuizGame.id.asc(),
        ).first()

    def create_waiting_game(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> CareerQuizGame:
        preset = self._preset_config(request.preset)
        game = career_service.create_game(
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
        game: CareerQuizGame,
        request: MatchmakingRequest,
        *,
        starting_player: int,
    ) -> CareerQuizGame:
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
        return career_service.join_game(
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
    ) -> CareerQuizGame:
        self._preset_config(request.preset)
        game = (
            db.query(CareerQuizGame)
            .filter(
                CareerQuizGame.id == request.game_id,
                CareerQuizGame.mode == "online_friend",
                CareerQuizGame.status == "waiting_for_opponent",
                CareerQuizGame.is_public.is_(True),
                CareerQuizGame.preset == request.preset,
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

    def _preset_config(self, preset: str) -> CareerQuizMatchmakingPreset:
        try:
            return self._presets[preset]
        except KeyError as exc:
            raise InvalidGameActionError("Unknown Career Quiz matchmaking preset") from exc

    @staticmethod
    def _validate_preset_config(
        preset: str,
        config: CareerQuizMatchmakingPreset,
    ) -> None:
        if config.target_wins not in career_service.VALID_TARGET_WINS:
            raise InvalidGameActionError(
                f"Invalid Career Quiz target_wins for preset '{preset}'"
            )
        if config.wrong_guess_visibility not in career_service.VALID_WRONG_GUESS_VISIBILITY:
            raise InvalidGameActionError(
                f"Invalid Career Quiz wrong_guess_visibility for preset '{preset}'"
            )
        if not isinstance(config.round_seconds, int) or config.round_seconds <= 0:
            raise InvalidGameActionError(
                f"Invalid Career Quiz round_seconds for preset '{preset}'"
            )


class GuessTheListMatchmakingAdapter:
    game_kind = GameKind.GUESS_THE_LIST.value

    def __init__(
        self,
        presets: Mapping[str, GuessTheListMatchmakingPreset] | None = None,
    ):
        source = DEFAULT_GUESS_THE_LIST_MATCHMAKING_PRESETS if presets is None else presets
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
    ) -> dict[str, GuessTheListQuickMatchPoolCounts]:
        counts = {
            preset: GuessTheListQuickMatchPoolCounts()
            for preset in self.preset_keys()
        }
        if not counts:
            return counts

        rows = (
            db.query(
                GuessTheListGame.preset,
                GuessTheListGame.status,
                func.count(GuessTheListGame.id),
            )
            .filter(
                GuessTheListGame.mode == "online_friend",
                GuessTheListGame.is_race.is_(True),
                GuessTheListGame.is_public.is_(True),
                GuessTheListGame.preset.in_(tuple(counts)),
                GuessTheListGame.status.in_(("waiting_for_opponent", "active")),
            )
            .group_by(GuessTheListGame.preset, GuessTheListGame.status)
            .all()
        )

        for preset, status, total in rows:
            current = counts[preset]
            total_count = int(total or 0)
            if status == "waiting_for_opponent":
                counts[preset] = GuessTheListQuickMatchPoolCounts(
                    searching=total_count,
                    in_progress=current.in_progress,
                )
            elif status == "active":
                counts[preset] = GuessTheListQuickMatchPoolCounts(
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
            db.query(GuessTheListGame)
            .filter(
                GuessTheListGame.mode == "online_friend",
                GuessTheListGame.is_race.is_(True),
                GuessTheListGame.status.in_(("waiting_for_opponent", "active")),
                GuessTheListGame.is_public.is_(True),
                GuessTheListGame.preset == request.preset,
                or_(
                    GuessTheListGame.player1_guest_id == request.guest_id,
                    GuessTheListGame.player2_guest_id == request.guest_id,
                ),
            )
            .order_by(
                GuessTheListGame.status.asc(),
                GuessTheListGame.created_at.asc(),
                GuessTheListGame.id.asc(),
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
    ) -> GuessTheListGame | None:
        self._preset_config(request.preset)
        query = db.query(GuessTheListGame).filter(
            GuessTheListGame.mode == "online_friend",
            GuessTheListGame.is_race.is_(True),
            GuessTheListGame.status == "waiting_for_opponent",
            GuessTheListGame.is_public.is_(True),
            GuessTheListGame.preset == request.preset,
        )
        if request.guest_id is not None:
            query = query.filter(
                or_(
                    GuessTheListGame.player1_guest_id.is_(None),
                    GuessTheListGame.player1_guest_id != request.guest_id,
                )
            )
        return query.order_by(
            GuessTheListGame.created_at.asc(),
            GuessTheListGame.id.asc(),
        ).first()

    def create_waiting_game(
        self,
        db: Session,
        request: MatchmakingRequest,
    ) -> GuessTheListGame:
        preset = self._preset_config(request.preset)
        game = guess_the_list_service.create_race_game(
            db,
            target_wins=preset.target_wins,
            player1_name=request.player_name,
            season_range_start=preset.season_range_start,
            season_range_end=preset.season_range_end,
            guest_id=request.guest_id,
            is_public=True,
            preset=request.preset,
            race_round_seconds=preset.round_seconds,
            race_reveal_seconds=preset.reveal_seconds,
        )
        db.flush()
        return game

    def join_waiting_game(
        self,
        db: Session,
        game: GuessTheListGame,
        request: MatchmakingRequest,
        *,
        starting_player: int,
    ) -> GuessTheListGame:
        if (
            game.mode != "online_friend"
            or not game.is_race
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
        return guess_the_list_service.join_race_game(
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
    ) -> GuessTheListGame:
        self._validate_cancel_preset(request.preset)
        game = (
            db.query(GuessTheListGame)
            .filter(
                GuessTheListGame.id == request.game_id,
                GuessTheListGame.mode == "online_friend",
                GuessTheListGame.is_race.is_(True),
                GuessTheListGame.status == "waiting_for_opponent",
                GuessTheListGame.is_public.is_(True),
                GuessTheListGame.preset == request.preset,
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

    def _validate_cancel_preset(self, preset: str) -> None:
        if preset in self._presets:
            return
        if preset in _LEGACY_GUESS_THE_LIST_MATCHMAKING_PRESET_KEYS:
            return
        self._preset_config(preset)

    def _preset_config(self, preset: str) -> GuessTheListMatchmakingPreset:
        try:
            return self._presets[preset]
        except KeyError as exc:
            raise InvalidGameActionError(
                "Unknown Guess the List matchmaking preset"
            ) from exc

    @staticmethod
    def _validate_preset_config(
        preset: str,
        config: GuessTheListMatchmakingPreset,
    ) -> None:
        if config.target_wins not in guess_the_list_service.RACE_TARGET_WINS_OPTIONS:
            raise InvalidGameActionError(
                f"Invalid Guess the List target_wins for preset '{preset}'"
            )
        if config.season_range_start > config.season_range_end:
            raise InvalidGameActionError(
                f"Invalid Guess the List season range for preset '{preset}'"
            )
        if not isinstance(config.round_seconds, int) or config.round_seconds <= 0:
            raise InvalidGameActionError(
                f"Invalid Guess the List round_seconds for preset '{preset}'"
            )
        if not isinstance(config.reveal_seconds, int) or config.reveal_seconds < 0:
            raise InvalidGameActionError(
                f"Invalid Guess the List reveal_seconds for preset '{preset}'"
            )
