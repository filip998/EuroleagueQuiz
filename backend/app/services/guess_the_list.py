import hashlib
import random
import string
import threading
import weakref
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import (
    Any,
    Callable,
    Generic,
    Mapping,
    Optional,
    Protocol,
    Sequence,
    TypeVar,
)

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.game_actions import (
    ConflictGameActionError,
    InvalidGameActionError,
    NotFoundGameActionError,
)
from app.models import (
    Game,
    GamePlayerStats,
    Player,
    PlayerSeasonTeam,
    Season,
    Team,
    TeamSeason,
)
from app.models.guess_the_list import GuessTheListGame, GuessTheListRound, GuessTheListSlot
from app.services.race_rounds import normalize_utc, parse_utc_datetime, reveal_window_starts_at

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUPPORTED_MODES = {"single_player", "local_two_player", "online_friend"}
LOCAL_PLAY_MODES = {"single_player", "local_two_player"}
TARGET_WINS_OPTIONS = {2, 3, 5}
TIMER_MODE_TO_SECONDS = {"15s": 15, "40s": 40, "unlimited": None}
RACE_TARGET_WINS_OPTIONS = {1, 2, 3}
RACE_ROUND_SECONDS = 120
RACE_REVEAL_SECONDS = 12

MIN_ROSTER_SIZE = 5
MAX_ROSTER_RETRIES = 10

CATEGORY_ROSTER = "roster"
CATEGORY_ALL_TIME = "all_time"
CATEGORY_SINGLE_SEASON = "single_season"
DEFAULT_CATEGORY_TYPE = CATEGORY_ROSTER
LEADERBOARD_METRICS = ("points", "rebounds", "assists", "pir")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


GuessTheListError = InvalidGameActionError
GuessTheListNotFoundError = NotFoundGameActionError
GuessTheListConflictError = ConflictGameActionError

GUEST_ID_MAX_LENGTH = 64
_race_locks_guard = threading.Lock()
_race_locks: weakref.WeakValueDictionary[int, Any] = weakref.WeakValueDictionary()
T = TypeVar("T")


@dataclass(frozen=True)
class RoundSlotSpec:
    player_id: int
    player_name: str
    player_season_team_id: int | None = None
    jersey_number: str | None = None
    position: str | None = None
    nationality: str | None = None
    height_cm: int | None = None
    rank: int | None = None
    stat_value: float | None = None
    stat_value_label: str | None = None


@dataclass(frozen=True)
class RoundSpec:
    category_type: str
    metric: str | None
    scope_label: str | None
    team_id: int | None
    season_id: int | None
    team_code: str | None
    team_name: str | None
    season_year: int | None
    slots: Sequence[RoundSlotSpec]


class GuessTheListRoundGenerator(Protocol):
    def build_round(
        self,
        db: Session,
        game: GuessTheListGame,
        round_number: int,
    ) -> RoundSpec:
        ...


@dataclass(frozen=True)
class RankedBoundaryItem(Generic[T]):
    item: T
    rank: int
    stat_value: float


@dataclass(frozen=True)
class LeaderboardMetricConfig:
    column: Any
    display_name: str
    unit: str


LEADERBOARD_METRIC_CONFIGS: Mapping[str, LeaderboardMetricConfig] = {
    "points": LeaderboardMetricConfig(GamePlayerStats.points, "points", "pts"),
    "rebounds": LeaderboardMetricConfig(
        GamePlayerStats.total_rebounds,
        "rebounds",
        "reb",
    ),
    "assists": LeaderboardMetricConfig(GamePlayerStats.assists, "assists", "ast"),
    "pir": LeaderboardMetricConfig(GamePlayerStats.pir, "PIR", "PIR"),
}


def ranked_items_with_boundary_ties(
    rows: Sequence[T],
    *,
    limit: int,
    stat_value: Callable[[T], int | float | Decimal],
) -> list[RankedBoundaryItem[T]]:
    """Competition-rank rows and include every tie at the cutoff boundary.

    ``rows`` must already be sorted from best to worst. If multiple players tie
    at rank ``limit``, every tied player is returned and shares that rank, so a
    generated round can contain more than ``limit`` slots.
    """

    if limit <= 0:
        return []

    ranked: list[RankedBoundaryItem[T]] = []
    previous_value: Decimal | None = None
    current_rank = 0

    for index, row in enumerate(rows, start=1):
        raw_value = stat_value(row)
        numeric_value = Decimal(str(raw_value))
        if previous_value is None or numeric_value != previous_value:
            current_rank = index
            previous_value = numeric_value
        if current_rank > limit:
            break
        ranked.append(
            RankedBoundaryItem(
                item=row,
                rank=current_rank,
                stat_value=float(numeric_value),
            )
        )

    return ranked


def _clean_guest_id(guest_id: Optional[str]) -> Optional[str]:
    """Normalize an opaque, untrusted client guest id (None when blank)."""
    if not guest_id:
        return None
    cleaned = guest_id.strip()[:GUEST_ID_MAX_LENGTH]
    return cleaned or None


def _clean_category_type(category_type: str | None) -> str:
    cleaned = (category_type or DEFAULT_CATEGORY_TYPE).strip().lower()
    return cleaned or DEFAULT_CATEGORY_TYPE


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _other_player(p: int) -> int:
    return 2 if p == 1 else 1


def _ensure_game_playable(game: GuessTheListGame) -> None:
    if game.status != "active":
        raise GuessTheListConflictError("Game is not active")


def _race_lock(game_id: int) -> threading.Lock:
    with _race_locks_guard:
        lock = _race_locks.get(game_id)
        if lock is None:
            lock = threading.Lock()
            _race_locks[game_id] = lock
        return lock


def _utc_isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    return normalize_utc(value).isoformat()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _generate_join_code(db: Session) -> str:
    for _ in range(100):
        code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
        existing = (
            db.query(GuessTheListGame)
            .filter(GuessTheListGame.join_code == code)
            .first()
        )
        if not existing:
            return code
    raise GuessTheListError("Unable to generate a unique join code")


class RosterGenerator:
    def build_round(
        self,
        db: Session,
        game: GuessTheListGame,
        round_number: int,
    ) -> RoundSpec:
        """Pick a random team+season and return the current roster answer set."""

        eligible_pairs = (
            db.query(PlayerSeasonTeam.team_id, PlayerSeasonTeam.season_id)
            .join(Season, Season.id == PlayerSeasonTeam.season_id)
            .filter(
                Season.year >= game.season_range_start,
                Season.year <= game.season_range_end,
            )
            .group_by(PlayerSeasonTeam.team_id, PlayerSeasonTeam.season_id)
            .having(func.count(PlayerSeasonTeam.id) >= MIN_ROSTER_SIZE)
            .all()
        )

        if not eligible_pairs:
            raise GuessTheListError(
                "No team+season combination with enough players in the selected range"
            )

        random.shuffle(eligible_pairs)

        roster_rows = None
        chosen_team_id = None
        chosen_season_id = None

        for team_id, season_id in eligible_pairs[:MAX_ROSTER_RETRIES]:
            rows = (
                db.query(
                    PlayerSeasonTeam.id.label("pst_id"),
                    PlayerSeasonTeam.player_id,
                    PlayerSeasonTeam.jersey_number,
                    Player.first_name,
                    Player.last_name,
                    Player.position,
                    Player.nationality,
                    Player.height_cm,
                )
                .join(Player, Player.id == PlayerSeasonTeam.player_id)
                .filter(
                    PlayerSeasonTeam.team_id == team_id,
                    PlayerSeasonTeam.season_id == season_id,
                )
                .all()
            )
            if len(rows) >= MIN_ROSTER_SIZE:
                roster_rows = rows
                chosen_team_id = team_id
                chosen_season_id = season_id
                break

        if roster_rows is None:
            raise GuessTheListError("Could not find a valid roster after retries")

        team = db.query(Team).filter(Team.id == chosen_team_id).first()
        season = db.query(Season).filter(Season.id == chosen_season_id).first()

        team_code = team.euroleague_code if team else "UNK"
        season_year = season.year if season else 0

        team_season = (
            db.query(TeamSeason)
            .filter(
                TeamSeason.team_id == chosen_team_id,
                TeamSeason.season_id == chosen_season_id,
            )
            .first()
        )
        team_name = (
            (
                team_season.team_name_that_season
                if team_season and team_season.team_name_that_season
                else None
            )
            or (team.name if team else "Unknown")
        )

        slots = []
        for row in roster_rows:
            full_name = f"{row.first_name or ''} {row.last_name or ''}".strip()
            slots.append(
                RoundSlotSpec(
                    player_season_team_id=row.pst_id,
                    player_id=row.player_id,
                    jersey_number=row.jersey_number,
                    position=row.position,
                    nationality=row.nationality,
                    height_cm=row.height_cm,
                    player_name=full_name or "Unknown",
                )
            )

        return RoundSpec(
            category_type=CATEGORY_ROSTER,
            metric=None,
            scope_label=f"{team_name} {season_year}",
            team_id=chosen_team_id,
            season_id=chosen_season_id,
            team_code=team_code,
            team_name=team_name,
            season_year=season_year,
            slots=tuple(slots),
        )


class AllTimeLeadersGenerator:
    def __init__(self, metric: str | None = None):
        if metric is not None and metric not in LEADERBOARD_METRIC_CONFIGS:
            raise GuessTheListError(f"Unsupported all-time leaderboard metric: {metric}")
        self._metric = metric

    def build_round(
        self,
        db: Session,
        game: GuessTheListGame,
        round_number: int,
    ) -> RoundSpec:
        metric = self._metric or random.choice(LEADERBOARD_METRICS)
        metric_config = LEADERBOARD_METRIC_CONFIGS[metric]
        total_value = func.coalesce(func.sum(metric_config.column), 0)
        last_name_order = func.coalesce(Player.last_name, "")
        first_name_order = func.coalesce(Player.first_name, "")

        rows = (
            db.query(
                Player.id.label("player_id"),
                Player.first_name,
                Player.last_name,
                Player.position,
                Player.nationality,
                Player.height_cm,
                total_value.label("total_value"),
            )
            .select_from(GamePlayerStats)
            .join(Game, Game.id == GamePlayerStats.game_id)
            .join(Season, Season.id == Game.season_id)
            .join(Player, Player.id == GamePlayerStats.player_id)
            .filter(
                Season.year >= game.season_range_start,
                Season.year <= game.season_range_end,
            )
            .group_by(
                Player.id,
                Player.first_name,
                Player.last_name,
                Player.position,
                Player.nationality,
                Player.height_cm,
            )
            .having(total_value > 0)
            .order_by(
                total_value.desc(),
                last_name_order.asc(),
                first_name_order.asc(),
                Player.id.asc(),
            )
            .all()
        )

        if not rows:
            raise GuessTheListError(
                "No all-time leaderboard stats found in the selected range"
            )

        ranked_rows = ranked_items_with_boundary_ties(
            rows,
            limit=10,
            stat_value=lambda row: row.total_value,
        )
        slots = []
        for ranked_row in ranked_rows:
            row = ranked_row.item
            player_name = f"{row.first_name or ''} {row.last_name or ''}".strip()
            total = int(ranked_row.stat_value)
            slots.append(
                RoundSlotSpec(
                    player_id=row.player_id,
                    position=row.position,
                    nationality=row.nationality,
                    height_cm=row.height_cm,
                    player_name=player_name or "Unknown",
                    rank=ranked_row.rank,
                    stat_value=ranked_row.stat_value,
                    stat_value_label=f"{total:,} {metric_config.unit}",
                )
            )

        return RoundSpec(
            category_type=CATEGORY_ALL_TIME,
            metric=metric,
            scope_label=(
                f"All-time {metric_config.display_name} leaders "
                f"({game.season_range_start}-{game.season_range_end})"
            ),
            team_id=None,
            season_id=None,
            team_code=None,
            team_name=None,
            season_year=None,
            slots=tuple(slots),
        )


ROUND_GENERATOR_REGISTRY: dict[str, GuessTheListRoundGenerator] = {
    CATEGORY_ALL_TIME: AllTimeLeadersGenerator(),
    CATEGORY_ROSTER: RosterGenerator(),
}


def _generator_for_category(
    category_type: str | None,
    *,
    registry: Mapping[str, GuessTheListRoundGenerator] | None = None,
) -> GuessTheListRoundGenerator:
    category = _clean_category_type(category_type)
    generators = ROUND_GENERATOR_REGISTRY if registry is None else registry
    generator = generators.get(category)
    if generator is None:
        raise GuessTheListError(f"Unsupported Guess the List category_type: {category}")
    return generator


# ---------------------------------------------------------------------------
# Game lifecycle
# ---------------------------------------------------------------------------


def create_game(
    db: Session,
    *,
    mode: str,
    target_wins: int,
    timer_mode: str,
    category_type: str | None = None,
    player1_name: Optional[str] = None,
    player2_name: Optional[str] = None,
    season_range_start: int,
    season_range_end: int,
    guest_id: Optional[str] = None,
) -> GuessTheListGame:
    if mode not in SUPPORTED_MODES:
        raise GuessTheListError(
            f"Invalid mode '{mode}'. Choose from: {', '.join(sorted(SUPPORTED_MODES))}"
        )
    if target_wins not in TARGET_WINS_OPTIONS:
        raise GuessTheListError("target_wins must be one of: 2, 3, 5")
    if timer_mode not in TIMER_MODE_TO_SECONDS:
        raise GuessTheListError("timer_mode must be one of: 15s, 40s, unlimited")
    if season_range_start > season_range_end:
        raise GuessTheListError("season_range_start must be <= season_range_end")
    cleaned_category_type = _clean_category_type(category_type)
    _generator_for_category(cleaned_category_type)

    is_online = mode == "online_friend"
    join_code = _generate_join_code(db) if is_online else None

    game = GuessTheListGame(
        mode=mode,
        status="waiting_for_opponent" if is_online else "active",
        join_code=join_code,
        is_race=False,
        is_public=False,
        preset=None,
        category_type=cleaned_category_type,
        target_wins=target_wins,
        turn_seconds=TIMER_MODE_TO_SECONDS[timer_mode],
        race_round_seconds=None,
        race_reveal_seconds=None,
        player1_name=player1_name,
        player2_name=player2_name,
        player1_guest_id=_clean_guest_id(guest_id),
        current_player=1,
        player1_score=0,
        player2_score=0,
        round_number=0,
        season_range_start=season_range_start,
        season_range_end=season_range_end,
        pending_end_from=None,
        pending_end_to=None,
        winner_player=None,
        turn_started_at=datetime.utcnow(),
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(game)
    db.flush()

    if not is_online:
        _create_next_round(db, game)
    db.flush()
    return game


def get_game_or_404(db: Session, game_id: int) -> GuessTheListGame:
    game = db.query(GuessTheListGame).filter(GuessTheListGame.id == game_id).first()
    if not game:
        raise GuessTheListNotFoundError("Game not found")
    return game


def join_game(
    db: Session,
    join_code: str,
    player2_name: Optional[str] = None,
    guest_id: Optional[str] = None,
    *,
    allow_public: bool = False,
) -> GuessTheListGame:
    game = (
        db.query(GuessTheListGame)
        .filter(GuessTheListGame.join_code == join_code.upper())
        .first()
    )
    if not game:
        raise GuessTheListNotFoundError("Invalid join code")
    if game.is_race:
        raise GuessTheListConflictError("Race games must be joined through Race endpoints")
    if game.is_public and not allow_public:
        raise GuessTheListConflictError("Public games must be joined through quick match")
    if game.status != "waiting_for_opponent":
        raise GuessTheListConflictError("Game is no longer accepting players")

    game.player2_name = player2_name or game.player2_name
    game.player2_guest_id = _clean_guest_id(guest_id) or game.player2_guest_id
    game.status = "active"
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now

    _create_next_round(db, game)
    db.flush()
    return game


def create_race_game(
    db: Session,
    *,
    target_wins: int,
    category_type: str | None = None,
    player1_name: Optional[str] = None,
    season_range_start: int,
    season_range_end: int,
    guest_id: Optional[str] = None,
    is_public: bool = False,
    preset: str | None = None,
    race_round_seconds: int = RACE_ROUND_SECONDS,
    race_reveal_seconds: int = RACE_REVEAL_SECONDS,
) -> GuessTheListGame:
    if target_wins not in RACE_TARGET_WINS_OPTIONS:
        raise GuessTheListError("race target_wins must be one of: 1, 2, 3")
    if season_range_start > season_range_end:
        raise GuessTheListError("season_range_start must be <= season_range_end")
    if race_round_seconds <= 0:
        raise GuessTheListError("race_round_seconds must be positive")
    if race_reveal_seconds < 0:
        raise GuessTheListError("race_reveal_seconds must be non-negative")
    cleaned_category_type = _clean_category_type(category_type)
    _generator_for_category(cleaned_category_type)

    game = GuessTheListGame(
        mode="online_friend",
        status="waiting_for_opponent",
        join_code=_generate_join_code(db),
        is_race=True,
        is_public=is_public,
        preset=preset,
        category_type=cleaned_category_type,
        target_wins=target_wins,
        turn_seconds=None,
        race_round_seconds=race_round_seconds,
        race_reveal_seconds=race_reveal_seconds,
        player1_name=player1_name or "Player 1",
        player2_name=None,
        player1_guest_id=_clean_guest_id(guest_id),
        current_player=0,
        player1_score=0,
        player2_score=0,
        round_number=0,
        season_range_start=season_range_start,
        season_range_end=season_range_end,
        pending_end_from=None,
        pending_end_to=None,
        winner_player=None,
        turn_started_at=None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(game)
    db.flush()
    return game


def join_race_game(
    db: Session,
    join_code: str,
    *,
    player_name: Optional[str] = None,
    guest_id: Optional[str] = None,
    allow_public: bool = False,
) -> GuessTheListGame:
    game = (
        db.query(GuessTheListGame)
        .filter(GuessTheListGame.join_code == join_code.upper())
        .first()
    )
    if not game:
        raise GuessTheListNotFoundError("Invalid join code")
    if not game.is_race:
        raise GuessTheListConflictError("Game is not a Race game")
    if game.is_public and not allow_public:
        raise GuessTheListConflictError("Public games must be joined through quick match")
    if game.status != "waiting_for_opponent":
        raise GuessTheListConflictError("Game is no longer accepting players")

    cleaned_guest_id = _clean_guest_id(guest_id)
    if cleaned_guest_id is not None and game.player1_guest_id == cleaned_guest_id:
        raise GuessTheListConflictError("Cannot join your own race")

    joined_at = datetime.utcnow()
    updated = (
        db.query(GuessTheListGame)
        .filter(GuessTheListGame.id == game.id)
        .filter(GuessTheListGame.is_race.is_(True))
        .filter(GuessTheListGame.status == "waiting_for_opponent")
        .update(
            {
                "player2_name": player_name or "Player 2",
                "player2_guest_id": cleaned_guest_id or game.player2_guest_id,
                "status": "active",
                "updated_at": joined_at,
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        raise GuessTheListConflictError("Game is no longer accepting players")

    game.player2_name = player_name or "Player 2"
    game.player2_guest_id = cleaned_guest_id or game.player2_guest_id
    game.status = "active"
    game.updated_at = joined_at
    _create_next_round(db, game)
    db.flush()
    return game


# ---------------------------------------------------------------------------
# Round creation
# ---------------------------------------------------------------------------


def _create_next_round(
    db: Session,
    game: GuessTheListGame,
    *,
    starts_at: datetime | None = None,
    registry: Mapping[str, GuessTheListRoundGenerator] | None = None,
) -> GuessTheListRound:
    """Build the configured answer set and create the next round."""
    next_round_number = (
        db.query(func.max(GuessTheListRound.round_number))
        .filter(GuessTheListRound.game_id == game.id)
        .scalar()
        or 0
    ) + 1
    generator = _generator_for_category(game.category_type, registry=registry)
    round_spec = generator.build_round(db, game, next_round_number)

    created_at = starts_at or datetime.utcnow()
    round_obj = GuessTheListRound(
        game_id=game.id,
        round_number=next_round_number,
        status="active",
        category_type=_clean_category_type(round_spec.category_type),
        metric=round_spec.metric,
        scope_label=round_spec.scope_label,
        team_id=round_spec.team_id,
        season_id=round_spec.season_id,
        team_code=round_spec.team_code,
        team_name=round_spec.team_name,
        season_year=round_spec.season_year,
        player1_correct=0,
        player2_correct=0,
        winner_player=None,
        created_at=created_at,
        completed_at=None,
    )
    db.add(round_obj)
    db.flush()

    for slot_spec in _slot_specs_for_storage(
        game.id,
        next_round_number,
        round_spec,
    ):
        db.add(
            GuessTheListSlot(
                round_id=round_obj.id,
                player_season_team_id=slot_spec.player_season_team_id,
                player_id=slot_spec.player_id,
                jersey_number=slot_spec.jersey_number,
                position=slot_spec.position,
                nationality=slot_spec.nationality,
                height_cm=slot_spec.height_cm,
                player_name=slot_spec.player_name,
                rank=slot_spec.rank,
                stat_value=slot_spec.stat_value,
                stat_value_label=slot_spec.stat_value_label,
                guessed_by_player=None,
                guessed_at=None,
            )
        )

    # Update game state
    game.round_number = next_round_number
    game.current_player = 0 if game.is_race else 1
    game.pending_end_from = None
    game.pending_end_to = None
    now = datetime.utcnow()
    game.turn_started_at = None if game.is_race else now
    game.updated_at = now
    db.flush()
    return round_obj


# ---------------------------------------------------------------------------
# Active round query
# ---------------------------------------------------------------------------


def get_active_round(db: Session, game_id: int) -> GuessTheListRound:
    round_obj = (
        db.query(GuessTheListRound)
        .filter(
            GuessTheListRound.game_id == game_id,
            GuessTheListRound.status == "active",
        )
        .order_by(GuessTheListRound.round_number.desc())
        .first()
    )
    if not round_obj:
        raise GuessTheListConflictError("No active round found for game")
    return round_obj


# ---------------------------------------------------------------------------
# Guess submission
# ---------------------------------------------------------------------------


def submit_guess(
    db: Session,
    *,
    game: GuessTheListGame,
    player_id: int,
    acting_player: Optional[int] = None,
) -> str:
    _ensure_game_playable(game)

    if game.pending_end_from is not None:
        raise GuessTheListConflictError("Resolve pending end offer before guessing")

    if game.mode == "online_friend":
        if acting_player is None:
            raise GuessTheListConflictError("Online game actions require realtime player identity")
        if acting_player != game.current_player:
            raise GuessTheListConflictError("It is not your turn")

    round_obj = get_active_round(db, game.id)

    # Find an unguessed slot matching this player_id
    slot = (
        db.query(GuessTheListSlot)
        .filter(
            GuessTheListSlot.round_id == round_obj.id,
            GuessTheListSlot.player_id == player_id,
            GuessTheListSlot.guessed_by_player.is_(None),
        )
        .first()
    )

    current = game.current_player
    is_correct = slot is not None

    if is_correct:
        slot.guessed_by_player = current
        slot.guessed_at = datetime.utcnow()
        if current == 1:
            round_obj.player1_correct += 1
        else:
            round_obj.player2_correct += 1

    # Switch turn (in two-player modes)
    if game.mode != "single_player":
        game.current_player = _other_player(current)

    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now

    # Check if all slots are guessed → round complete
    unguessed_count = (
        db.query(func.count(GuessTheListSlot.id))
        .filter(
            GuessTheListSlot.round_id == round_obj.id,
            GuessTheListSlot.guessed_by_player.is_(None),
        )
        .scalar()
    )

    if unguessed_count == 0:
        return _finish_round(db, game, round_obj)

    db.flush()
    return "correct" if is_correct else "incorrect"


def submit_race_claim(
    db: Session,
    *,
    game: GuessTheListGame,
    player_id: int,
    acting_player: int,
    round_number: int,
) -> str:
    if acting_player not in (1, 2):
        raise GuessTheListConflictError("Online game actions require realtime player identity")
    if not game.is_race:
        raise GuessTheListConflictError("Game is not a Race game")

    with _race_lock(game.id):
        _ensure_game_playable(game)
        _raise_if_race_round_stale(game, round_number)
        _raise_if_race_round_locked(game)
        round_obj = get_active_round(db, game.id)
        _assert_active_race_round(db, game, round_obj, round_number)

        now = datetime.utcnow()
        deadline = _race_round_deadline_at(game)
        if deadline is not None and normalize_utc(now) >= deadline:
            result = _finish_race_round(
                db,
                game,
                round_obj,
                expected_round=round_number,
                completed_at=now,
            )
            if result is not None:
                return result
            return "incorrect"

        updated = (
            db.query(GuessTheListSlot)
            .filter(GuessTheListSlot.round_id == round_obj.id)
            .filter(GuessTheListSlot.player_id == player_id)
            .filter(GuessTheListSlot.guessed_by_player.is_(None))
            .filter(
                GuessTheListSlot.round.has(
                    (GuessTheListRound.status == "active")
                    & (GuessTheListRound.game_id == game.id)
                    & (
                        GuessTheListRound.game.has(
                            (GuessTheListGame.status == "active")
                            & (GuessTheListGame.is_race.is_(True))
                            & (GuessTheListGame.round_number == round_number)
                        )
                    )
                )
            )
            .update(
                {
                    "guessed_by_player": acting_player,
                    "guessed_at": now,
                },
                synchronize_session=False,
            )
        )

        if updated != 1:
            _assert_active_race_round(db, game, round_obj, round_number)
            return "incorrect"

        _sync_race_claim_counts(db, round_obj)
        if _race_unguessed_count(db, round_obj) == 0:
            result = _finish_race_round(
                db,
                game,
                round_obj,
                expected_round=round_number,
                completed_at=now,
            )
            if result is not None:
                return result

        game.updated_at = now
        db.flush()
        return "correct"


def _raise_if_race_round_stale(game: GuessTheListGame, round_number: int) -> None:
    if round_number != game.round_number:
        raise GuessTheListConflictError("round_stale")


def _raise_if_race_round_locked(game: GuessTheListGame) -> None:
    if _race_reveal_window_starts_at(game) is not None:
        raise GuessTheListConflictError("round_locked")


def _assert_active_race_round(
    db: Session,
    game: GuessTheListGame,
    round_obj: GuessTheListRound,
    round_number: int,
) -> None:
    exists = (
        db.query(GuessTheListRound.id)
        .join(GuessTheListGame, GuessTheListGame.id == GuessTheListRound.game_id)
        .filter(GuessTheListRound.id == round_obj.id)
        .filter(GuessTheListRound.status == "active")
        .filter(GuessTheListGame.id == game.id)
        .filter(GuessTheListGame.is_race.is_(True))
        .filter(GuessTheListGame.status == "active")
        .filter(GuessTheListGame.round_number == round_number)
        .first()
    )
    if exists is None:
        raise GuessTheListConflictError("round_stale")


def _sync_race_claim_counts(db: Session, round_obj: GuessTheListRound) -> None:
    player1_count = _race_claim_count(db, round_obj, 1)
    player2_count = _race_claim_count(db, round_obj, 2)
    db.query(GuessTheListRound).filter(GuessTheListRound.id == round_obj.id).update(
        {
            "player1_correct": player1_count,
            "player2_correct": player2_count,
        },
        synchronize_session=False,
    )
    round_obj.player1_correct = player1_count
    round_obj.player2_correct = player2_count


def _race_claim_count(db: Session, round_obj: GuessTheListRound, player: int) -> int:
    return int(
        db.query(func.count(GuessTheListSlot.id))
        .filter(GuessTheListSlot.round_id == round_obj.id)
        .filter(GuessTheListSlot.guessed_by_player == player)
        .scalar()
        or 0
    )


def _race_unguessed_count(db: Session, round_obj: GuessTheListRound) -> int:
    return int(
        db.query(func.count(GuessTheListSlot.id))
        .filter(GuessTheListSlot.round_id == round_obj.id)
        .filter(GuessTheListSlot.guessed_by_player.is_(None))
        .scalar()
        or 0
    )


def _finish_round(
    db: Session,
    game: GuessTheListGame,
    round_obj: GuessTheListRound,
) -> str:
    """Complete the round, update scores, and check for match end."""
    round_obj.status = "completed"

    if game.mode == "single_player":
        # Solo: no match scoring — just complete the roster and prepare next
        round_obj.winner_player = None
        _create_next_round(db, game)
        db.flush()
        return "board_complete"

    if round_obj.player1_correct > round_obj.player2_correct:
        round_obj.winner_player = 1
    elif round_obj.player2_correct > round_obj.player1_correct:
        round_obj.winner_player = 2
    else:
        round_obj.winner_player = None  # drawn round

    if round_obj.winner_player is not None:
        if round_obj.winner_player == 1:
            game.player1_score += 1
        else:
            game.player2_score += 1

    if max(game.player1_score, game.player2_score) >= game.target_wins:
        game.status = "finished"
        game.winner_player = (
            1 if game.player1_score >= game.target_wins else 2
        )
        game.pending_end_from = None
        game.pending_end_to = None
        game.updated_at = datetime.utcnow()
        db.flush()
        return "match_won"

    _create_next_round(db, game)
    db.flush()
    return "round_won" if round_obj.winner_player is not None else "round_complete"


def _finish_race_round(
    db: Session,
    game: GuessTheListGame,
    round_obj: GuessTheListRound,
    *,
    expected_round: int,
    completed_at: datetime | None = None,
) -> str | None:
    if not game.is_race:
        raise GuessTheListConflictError("Game is not a Race game")
    if game.status != "active" or game.round_number != expected_round:
        return None

    completed_at = completed_at or datetime.utcnow()
    updated = (
        db.query(GuessTheListRound)
        .filter(GuessTheListRound.id == round_obj.id)
        .filter(GuessTheListRound.status == "active")
        .update(
            {
                "status": "completed",
                "completed_at": completed_at,
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        return None

    round_obj.status = "completed"
    round_obj.completed_at = completed_at
    _sync_race_claim_counts(db, round_obj)

    if round_obj.player1_correct > round_obj.player2_correct:
        round_obj.winner_player = 1
    elif round_obj.player2_correct > round_obj.player1_correct:
        round_obj.winner_player = 2
    else:
        round_obj.winner_player = None

    if round_obj.winner_player == 1:
        game.player1_score += 1
    elif round_obj.winner_player == 2:
        game.player2_score += 1

    game.pending_end_from = None
    game.pending_end_to = None
    game.updated_at = completed_at

    if max(game.player1_score, game.player2_score) >= game.target_wins:
        game.status = "finished"
        game.winner_player = 1 if game.player1_score >= game.target_wins else 2
        db.flush()
        return "match_won"

    next_round_starts_at = completed_at + timedelta(
        seconds=game.race_reveal_seconds or RACE_REVEAL_SECONDS
    )
    _create_next_round(db, game, starts_at=next_round_starts_at)
    db.flush()
    return "round_won" if round_obj.winner_player is not None else "round_complete"


def forfeit_online_game(
    db: Session,
    game: GuessTheListGame,
    *,
    forfeiting_player: int,
) -> bool:
    """Finish an online Guess the List Race game because one player resigned/disconnected.

    The forfeiting player loses; the remaining player wins.  The current
    active race round is completed so both sides see the roster reveal.
    For non-race online games the function is a no-op (disconnect forfeits
    are only enabled for Race games via the adapter's eligibility check).
    Idempotent: a no-op if the game is already finished.

    Returns ``True`` only when this call transitioned the game from
    ``active`` to ``finished``; ``False`` if it was already finished (so
    callers can avoid broadcasting a misleading terminal result).
    """
    if game.mode != "online_friend":
        raise GuessTheListConflictError("Forfeit is only available in online games")
    if game.status != "active":
        return False
    if forfeiting_player not in (1, 2):
        raise GuessTheListError("forfeiting_player must be 1 or 2")

    winning_player = _other_player(forfeiting_player)
    now = datetime.utcnow()

    try:
        round_obj = get_active_round(db, game.id)
        if game.is_race:
            db.query(GuessTheListRound).filter(
                GuessTheListRound.id == round_obj.id,
                GuessTheListRound.status == "active",
            ).update(
                {"status": "completed", "completed_at": now},
                synchronize_session=False,
            )
            round_obj.status = "completed"
            round_obj.completed_at = now
        else:
            round_obj.status = "completed"
            round_obj.completed_at = now
    except GuessTheListConflictError:
        pass

    game.status = "finished"
    game.winner_player = winning_player
    game.pending_end_from = None
    game.pending_end_to = None
    game.updated_at = now
    db.flush()
    return True


# ---------------------------------------------------------------------------
# End-of-round offer
# ---------------------------------------------------------------------------


def offer_end(
    db: Session,
    game: GuessTheListGame,
    *,
    acting_player: Optional[int] = None,
) -> None:
    _ensure_game_playable(game)
    if game.is_race:
        raise GuessTheListConflictError("End offers are not available in Race mode")
    if game.pending_end_from is not None:
        raise GuessTheListConflictError("An end offer is already pending")

    if game.mode == "online_friend":
        if acting_player is None:
            raise GuessTheListConflictError("Online game actions require realtime player identity")
        if acting_player != game.current_player:
            raise GuessTheListConflictError("It is not your turn")

    get_active_round(db, game.id)
    offered_by = game.current_player
    game.pending_end_from = offered_by
    game.pending_end_to = _other_player(offered_by)
    game.current_player = game.pending_end_to
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()


def respond_end(
    db: Session,
    game: GuessTheListGame,
    *,
    accept: bool,
    acting_player: Optional[int] = None,
) -> str:
    _ensure_game_playable(game)
    if game.is_race:
        raise GuessTheListConflictError("End offers are not available in Race mode")
    if game.pending_end_from is None or game.pending_end_to is None:
        raise GuessTheListConflictError("No pending end offer")

    if game.mode == "online_friend":
        if acting_player is None:
            raise GuessTheListConflictError("Online game actions require realtime player identity")
        if acting_player != game.pending_end_to:
            raise GuessTheListConflictError(
                "Only the recipient can respond to the end offer"
            )

    round_obj = get_active_round(db, game.id)
    responder = game.current_player
    if responder != game.pending_end_to:
        raise GuessTheListConflictError("Current player cannot respond to end offer")

    if accept:
        return _finish_round(db, game, round_obj)

    game.pending_end_from = None
    game.pending_end_to = None
    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()
    return "declined"


# ---------------------------------------------------------------------------
# Timer handling
# ---------------------------------------------------------------------------


def race_round_timer_delay_seconds(
    game: GuessTheListGame,
    *,
    now: datetime | None = None,
) -> float | None:
    deadline = _race_round_deadline_at(game)
    if deadline is None:
        return None
    now_utc = normalize_utc(now or _utc_now())
    return max((deadline - now_utc).total_seconds(), 0.001)


def race_round_timer_delay_seconds_from_state(
    game_state: dict[str, Any],
    *,
    now: datetime | None = None,
) -> float | None:
    if (
        game_state.get("mode") != "online_friend"
        or game_state.get("status") != "active"
        or not game_state.get("is_race")
    ):
        return None
    current_round = game_state.get("round")
    if not isinstance(current_round, dict) or current_round.get("status") != "active":
        return None
    deadline = parse_utc_datetime(game_state.get("race_round_deadline_utc"))
    if deadline is None:
        return None
    now_utc = normalize_utc(now or _utc_now())
    return max((deadline - now_utc).total_seconds(), 0.001)


def handle_race_round_time_expired(
    db: Session,
    game: GuessTheListGame,
    *,
    expected_round: int,
) -> bool:
    if not game.is_race:
        return False

    with _race_lock(game.id):
        if game.status != "active" or game.round_number != expected_round:
            return False
        if _race_reveal_window_starts_at(game) is not None:
            return False

        deadline = _race_round_deadline_at(game)
        if deadline is None or normalize_utc(_utc_now()) < deadline:
            return False

        try:
            round_obj = get_active_round(db, game.id)
        except GuessTheListConflictError:
            return False
        result = _finish_race_round(
            db,
            game,
            round_obj,
            expected_round=expected_round,
            completed_at=datetime.utcnow(),
        )
        return result is not None


def handle_race_game_unattended_time_expired(
    db: Session,
    game: GuessTheListGame,
    *,
    expected_round: int,
) -> bool:
    if not game.is_race:
        return False

    with _race_lock(game.id):
        if game.status != "active" or game.round_number != expected_round:
            return False
        if _race_reveal_window_starts_at(game) is not None:
            return False

        deadline = _race_round_deadline_at(game)
        if deadline is None or normalize_utc(_utc_now()) < deadline:
            return False

        try:
            round_obj = get_active_round(db, game.id)
        except GuessTheListConflictError:
            return False

        completed_at = datetime.utcnow()
        updated = (
            db.query(GuessTheListRound)
            .filter(GuessTheListRound.id == round_obj.id)
            .filter(GuessTheListRound.status == "active")
            .update(
                {
                    "status": "completed",
                    "completed_at": completed_at,
                    "winner_player": None,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            return False

        round_obj.status = "completed"
        round_obj.completed_at = completed_at
        round_obj.winner_player = None
        _sync_race_claim_counts(db, round_obj)

        game.status = "finished"
        game.winner_player = None
        game.pending_end_from = None
        game.pending_end_to = None
        game.updated_at = completed_at
        db.flush()
        return True


def handle_time_expired(
    db: Session,
    game: GuessTheListGame,
    *,
    expected_player: Optional[int] = None,
    expected_round: Optional[int] = None,
) -> None:
    _ensure_game_playable(game)

    # Race guard: only act if the game is still on the expected turn/round
    if expected_player is not None and game.current_player != expected_player:
        return
    if expected_round is not None and game.round_number != expected_round:
        return

    game.pending_end_from = None
    game.pending_end_to = None
    if game.mode != "single_player":
        game.current_player = _other_player(game.current_player)

    now = datetime.utcnow()
    game.turn_started_at = now
    game.updated_at = now
    db.flush()


def _race_round_deadline_at(game: GuessTheListGame) -> datetime | None:
    if not game.is_race or game.status != "active":
        return None
    try:
        round_obj = _current_game_round(game)
    except GuessTheListConflictError:
        return None
    if round_obj.status != "active":
        return None
    starts_at = _race_round_starts_at(game, round_obj)
    if starts_at is None:
        return None
    return starts_at + timedelta(seconds=game.race_round_seconds or RACE_ROUND_SECONDS)


def _race_round_starts_at(
    game: GuessTheListGame,
    round_obj: GuessTheListRound,
) -> datetime | None:
    previous_round = _previous_completed_race_round_for_current(game)
    if previous_round is not None and previous_round.completed_at is not None:
        return normalize_utc(previous_round.completed_at) + timedelta(
            seconds=game.race_reveal_seconds or RACE_REVEAL_SECONDS
        )
    return normalize_utc(round_obj.created_at)


def _race_reveal_window_starts_at(
    game: GuessTheListGame,
    *,
    now: datetime | None = None,
) -> datetime | None:
    if not game.is_race or game.status != "active":
        return None
    try:
        current_round = _current_game_round(game)
    except GuessTheListConflictError:
        return None
    if current_round.status != "active":
        return None
    previous_round = _previous_completed_race_round_for_current(game)
    if previous_round is None:
        return None
    return reveal_window_starts_at(
        previous_round.completed_at,
        reveal_seconds=game.race_reveal_seconds or RACE_REVEAL_SECONDS,
        now=now,
    )


def _previous_completed_race_round_for_current(
    game: GuessTheListGame,
) -> GuessTheListRound | None:
    previous_round_number = game.round_number - 1
    if previous_round_number < 1:
        return None
    for round_obj in game.rounds:
        if round_obj.round_number == previous_round_number and round_obj.status == "completed":
            return round_obj
    return None


def _current_game_round(game: GuessTheListGame) -> GuessTheListRound:
    for round_obj in game.rounds:
        if round_obj.round_number == game.round_number:
            return round_obj
    raise GuessTheListConflictError("Current round not found")


# ---------------------------------------------------------------------------
# Give up (single player)
# ---------------------------------------------------------------------------


def give_up(db: Session, game: GuessTheListGame) -> int:
    """Single-player gives up on the current round. Reveals the full roster
    and creates the next round (like tic-tac-toe). Returns the given-up
    round number so the caller can serialize it as ``completed_round``."""
    _ensure_game_playable(game)
    if game.is_race:
        raise GuessTheListConflictError("Give up is not available in Race mode")
    if game.mode != "single_player":
        raise GuessTheListConflictError("Give up is only available in single player mode")

    round_obj = get_active_round(db, game.id)
    given_up_round_number = round_obj.round_number
    round_obj.status = "given_up"
    round_obj.winner_player = None
    _create_next_round(db, game)
    db.flush()
    return given_up_round_number


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def serialize_game_state(db: Session, game: GuessTheListGame) -> dict:
    round_obj = None
    if game.status == "active":
        round_obj = (
            db.query(GuessTheListRound)
            .filter(
                GuessTheListRound.game_id == game.id,
                GuessTheListRound.status == "active",
            )
            .order_by(GuessTheListRound.round_number.desc())
            .first()
        )
    if round_obj is None and game.round_number > 0:
        round_obj = (
            db.query(GuessTheListRound)
            .filter(GuessTheListRound.game_id == game.id)
            .order_by(GuessTheListRound.round_number.desc())
            .first()
        )

    round_payload = None
    if round_obj:
        round_payload = _serialize_round(round_obj)

    turn_deadline = None
    if game.turn_seconds is not None and game.turn_started_at is not None:
        turn_deadline = (
            game.turn_started_at + timedelta(seconds=game.turn_seconds)
        ).isoformat() + "Z"

    latest_completed_round = _latest_completed_round_payload(db, game)
    race_round_deadline = _utc_isoformat(_race_round_deadline_at(game))

    return {
        "id": game.id,
        "mode": game.mode,
        "status": game.status,
        "join_code": None if game.is_public else game.join_code,
        "is_race": game.is_race,
        "is_public": game.is_public,
        "preset": game.preset,
        "category_type": _clean_category_type(game.category_type),
        "target_wins": game.target_wins,
        "turn_seconds": game.turn_seconds,
        "turn_deadline_utc": turn_deadline,
        "race_round_seconds": game.race_round_seconds,
        "race_reveal_seconds": game.race_reveal_seconds,
        "race_round_deadline_utc": race_round_deadline,
        "player1_name": game.player1_name or "Player 1",
        "player2_name": game.player2_name or "Player 2",
        "player1_score": game.player1_score,
        "player2_score": game.player2_score,
        "current_player": game.current_player,
        "round_number": game.round_number,
        "winner_player": game.winner_player,
        "season_range_start": game.season_range_start,
        "season_range_end": game.season_range_end,
        "pending_end": {
            "offered_by": game.pending_end_from,
            "respond_to": game.pending_end_to,
        }
        if game.pending_end_from is not None
        else None,
        "round": round_payload,
        "latest_completed_round": latest_completed_round,
    }


def _serialize_round(round_obj: GuessTheListRound) -> dict:
    slots = list(round_obj.slots)
    guessed_count = sum(1 for s in slots if s.guessed_by_player is not None)
    round_over = round_obj.status in ("completed", "given_up")

    return {
        "round_number": round_obj.round_number,
        "category_type": _clean_category_type(round_obj.category_type),
        "metric": round_obj.metric,
        "scope_label": round_obj.scope_label,
        "team_code": round_obj.team_code,
        "team_name": round_obj.team_name,
        "season_year": round_obj.season_year,
        "player1_correct": round_obj.player1_correct,
        "player2_correct": round_obj.player2_correct,
        "winner_player": round_obj.winner_player,
        "completed_at": _utc_isoformat(round_obj.completed_at),
        "total_slots": len(slots),
        "guessed_count": guessed_count,
        "status": round_obj.status,
        "slots": [
            _serialize_slot(
                slot,
                round_over,
                category_type=_clean_category_type(round_obj.category_type),
            )
            for slot in _slots_for_serialization(round_obj, slots, round_over)
        ],
    }


def _latest_completed_round_payload(
    db: Session,
    game: GuessTheListGame,
) -> dict[str, Any] | None:
    if not game.is_race:
        return None
    round_obj = (
        db.query(GuessTheListRound)
        .filter(GuessTheListRound.game_id == game.id)
        .filter(GuessTheListRound.status == "completed")
        .order_by(GuessTheListRound.round_number.desc())
        .first()
    )
    if round_obj is None:
        return None
    payload = _serialize_round(round_obj)
    next_round_starts_at = _race_reveal_window_starts_at(game)
    if (
        next_round_starts_at is not None
        and round_obj.round_number == game.round_number - 1
    ):
        payload["next_round_starts_at"] = _utc_isoformat(next_round_starts_at)
    else:
        payload["next_round_starts_at"] = None
    return payload


# Reuse the TicTacToe nationality mapping for flag images
from app.services.tictactoe import NATIONALITY_TO_COUNTRY_CODE


def _slot_specs_for_storage(
    game_id: int,
    round_number: int,
    round_spec: RoundSpec,
) -> list[RoundSlotSpec]:
    slots = list(round_spec.slots)
    if _clean_category_type(round_spec.category_type) == CATEGORY_ROSTER:
        return slots
    return [
        slot
        for _, slot in sorted(
            enumerate(slots),
            key=lambda item: _slot_storage_order_key(
                game_id,
                round_number,
                item[0],
                item[1],
            ),
        )
    ]


def _slot_storage_order_key(
    game_id: int,
    round_number: int,
    index: int,
    slot: RoundSlotSpec,
) -> str:
    return hashlib.sha256(
        f"{game_id}:{round_number}:{index}:{slot.player_id}".encode("ascii")
    ).hexdigest()


def _slots_for_serialization(
    round_obj: GuessTheListRound,
    slots: Sequence[GuessTheListSlot],
    round_over: bool,
) -> list[GuessTheListSlot]:
    if _clean_category_type(round_obj.category_type) == CATEGORY_ROSTER:
        return list(slots)
    if round_over:
        return sorted(slots, key=_revealed_slot_order_key)
    return sorted(slots, key=lambda slot: _hidden_slot_order_key(round_obj.id, slot.id))


def _revealed_slot_order_key(slot: GuessTheListSlot) -> tuple[bool, int, str, int, int]:
    return (
        slot.rank is None,
        slot.rank or 0,
        (slot.player_name or "").casefold(),
        slot.player_id or 0,
        slot.id or 0,
    )


def _hidden_slot_order_key(round_id: int, slot_id: int) -> str:
    return hashlib.sha256(f"{round_id}:{slot_id}".encode("ascii")).hexdigest()


def _serialize_slot(slot, round_over: bool, *, category_type: str) -> dict:
    show_answer = slot.guessed_by_player is not None or round_over
    show_hints = show_answer or category_type == CATEGORY_ROSTER
    data = {
        "id": slot.id,
        "jersey_number": slot.jersey_number if show_hints else None,
        "position": slot.position if show_hints else None,
        "nationality": slot.nationality if show_hints else None,
        "height_cm": slot.height_cm if show_hints else None,
        "guessed_by_player": slot.guessed_by_player,
        "guessed_at": _utc_isoformat(slot.guessed_at),
        "player_name": slot.player_name if show_answer else None,
        "rank": slot.rank if show_answer else None,
        "stat_value": (
            float(slot.stat_value)
            if show_answer and slot.stat_value is not None
            else None
        ),
        "stat_value_label": slot.stat_value_label if show_answer else None,
    }
    # Include country code for flag display
    if show_hints and slot.nationality:
        code = NATIONALITY_TO_COUNTRY_CODE.get(slot.nationality)
        if code:
            data["country_code"] = code
    # Include player image when answer is revealed
    if show_answer and slot.player and slot.player.euroleague_image_url:
        data["image_url"] = slot.player.euroleague_image_url
    return data


def serialize_completed_round(
    db: Session, game_id: int, round_number: int
) -> dict | None:
    """Return serialized data for a completed/given-up round (used after give-up)."""
    round_obj = (
        db.query(GuessTheListRound)
        .filter(
            GuessTheListRound.game_id == game_id,
            GuessTheListRound.round_number == round_number,
        )
        .first()
    )
    if not round_obj:
        return None
    return _serialize_round(round_obj)


# ---------------------------------------------------------------------------
# Autocomplete (simple wrapper — no team filtering needed for Guess the List)
# ---------------------------------------------------------------------------


def autocomplete_players(
    db: Session,
    *,
    q: str,
    limit: int,
) -> list[dict]:
    from sqlalchemy import or_

    query = db.query(Player)
    if q:
        words = q.split()
        for word in words:
            pattern = f"%{word}%"
            query = query.filter(
                or_(
                    Player.first_name.ilike(pattern),
                    Player.last_name.ilike(pattern),
                )
            )

    players = (
        query.order_by(Player.last_name.asc(), Player.first_name.asc())
        .limit(limit)
        .all()
    )
    return [
        {
            "player_id": p.id,
            "first_name": p.first_name,
            "last_name": p.last_name,
            "full_name": f"{p.first_name or ''} {p.last_name or ''}".strip(),
        }
        for p in players
    ]
