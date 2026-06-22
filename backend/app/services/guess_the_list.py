import hashlib
import random
import string
import threading
import weakref
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
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

from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session

from app.game_actions import (
    ConflictGameActionError,
    InvalidGameActionError,
    NotFoundGameActionError,
)
from app.models import (
    Game,
    GamePlayerStats,
    AwardDataRevision,
    Player,
    PlayerAwardSelection,
    PlayerSeasonTeam,
    PlayerSeasonStats,
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
CATEGORY_ALL_EUROLEAGUE = "all_euroleague"
CATEGORY_AWARD_WINNERS = "award_winners"
DEFAULT_CATEGORY_TYPE = CATEGORY_ROSTER
LEADERBOARD_METRICS = ("points", "rebounds", "assists", "pir")
QUICK_MATCH_CATEGORY_TYPES = (
    CATEGORY_ROSTER,
    CATEGORY_ALL_TIME,
    CATEGORY_SINGLE_SEASON,
)


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


@dataclass(frozen=True)
class SingleSeasonMetricConfig:
    season_column: Any
    game_column: Any
    display_name: str
    per_game_unit: str


@dataclass(frozen=True)
class SingleSeasonCandidate:
    player_id: int
    player_season_team_id: int | None
    first_name: str | None
    last_name: str | None
    position: str | None
    nationality: str | None
    height_cm: int | None
    jersey_number: str | None
    games_played: int
    total_value: Decimal
    average_value: Decimal


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


SINGLE_SEASON_METRIC_CONFIGS: Mapping[str, SingleSeasonMetricConfig] = {
    "points": SingleSeasonMetricConfig(
        PlayerSeasonStats.points,
        GamePlayerStats.points,
        "points",
        "ppg",
    ),
    "rebounds": SingleSeasonMetricConfig(
        PlayerSeasonStats.total_rebounds,
        GamePlayerStats.total_rebounds,
        "rebounds",
        "rpg",
    ),
    "assists": SingleSeasonMetricConfig(
        PlayerSeasonStats.assists,
        GamePlayerStats.assists,
        "assists",
        "apg",
    ),
    "pir": SingleSeasonMetricConfig(
        PlayerSeasonStats.pir,
        GamePlayerStats.pir,
        "PIR",
        "PIR",
    ),
}

ALL_EUROLEAGUE_AWARD_KEY = "all_euroleague"
ALL_EUROLEAGUE_METRIC_FIRST = "first"
ALL_EUROLEAGUE_METRIC_SECOND = "second"
ALL_EUROLEAGUE_METRIC_FIRST_SECOND = "first_second"
ALL_EUROLEAGUE_MIN_FIRST_SLOTS = 5
ALL_EUROLEAGUE_MIN_FIRST_SECOND_SLOTS = 10
ALL_EUROLEAGUE_TIER_LABELS = {
    ALL_EUROLEAGUE_METRIC_FIRST: "First Team",
    ALL_EUROLEAGUE_METRIC_SECOND: "Second Team",
}
ALL_EUROLEAGUE_TIER_RANKS = {
    ALL_EUROLEAGUE_METRIC_FIRST: 1,
    ALL_EUROLEAGUE_METRIC_SECOND: 2,
}

AWARD_WINNER_REGULAR_SEASON_MVP = "regular_season_mvp"
AWARD_WINNER_FINAL_FOUR_MVP = "final_four_mvp"


@dataclass(frozen=True)
class AwardWinnerMetricConfig:
    award_key: str
    scope_label: str
    stat_label: str
    window_size: int
    min_unique_winners: int


@dataclass(frozen=True)
class AwardWinnerWindow:
    metric: str
    config: AwardWinnerMetricConfig
    season_years: tuple[int, ...]
    rows_by_player_id: tuple[
        tuple[int, tuple[tuple[PlayerAwardSelection, Player, Season], ...]],
        ...,
    ]


AWARD_WINNER_METRIC_CONFIGS: Mapping[str, AwardWinnerMetricConfig] = {
    AWARD_WINNER_REGULAR_SEASON_MVP: AwardWinnerMetricConfig(
        award_key=AWARD_WINNER_REGULAR_SEASON_MVP,
        scope_label="EuroLeague MVPs",
        stat_label="MVP",
        window_size=7,
        min_unique_winners=5,
    ),
    AWARD_WINNER_FINAL_FOUR_MVP: AwardWinnerMetricConfig(
        award_key=AWARD_WINNER_FINAL_FOUR_MVP,
        scope_label="Final Four MVPs",
        stat_label="F4 MVP",
        window_size=10,
        min_unique_winners=6,
    ),
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


class SingleSeasonLeadersGenerator:
    """Build per-game leader rounds, retrying thin season/metric candidates.

    A shuffled candidate list is exhausted before failing so wide season ranges
    do not randomly miss valid rounds. Pre-2007 seasons use box-score totals;
    2007+ seasons use aggregated season-stat rows.
    """

    def __init__(self, metric: str | None = None):
        if metric is not None and metric not in SINGLE_SEASON_METRIC_CONFIGS:
            raise GuessTheListError(f"Unsupported single-season metric: {metric}")
        self._metric = metric

    def build_round(
        self,
        db: Session,
        game: GuessTheListGame,
        round_number: int,
    ) -> RoundSpec:
        season_rows = (
            db.query(Season.id, Season.year)
            .filter(
                Season.year >= game.season_range_start,
                Season.year <= game.season_range_end,
            )
            .order_by(Season.year.asc())
            .all()
        )
        if not season_rows:
            raise GuessTheListError("No seasons found in the selected range")

        metrics = (self._metric,) if self._metric is not None else LEADERBOARD_METRICS
        candidates = [
            (season_id, season_year, metric)
            for season_id, season_year in season_rows
            for metric in metrics
        ]
        random.shuffle(candidates)

        for season_id, season_year, metric in candidates:
            metric_config = SINGLE_SEASON_METRIC_CONFIGS[metric]
            rows = self._ranked_rows_for_candidate(
                db,
                season_id=season_id,
                season_year=season_year,
                metric_config=metric_config,
            )
            if len(rows) < 10:
                continue

            slots = []
            for ranked_row in rows:
                row = ranked_row.item
                player_name = f"{row.first_name or ''} {row.last_name or ''}".strip()
                display_value = _round_single_season_average(row.average_value)
                slots.append(
                    RoundSlotSpec(
                        player_season_team_id=row.player_season_team_id,
                        player_id=row.player_id,
                        jersey_number=row.jersey_number,
                        position=row.position,
                        nationality=row.nationality,
                        height_cm=row.height_cm,
                        player_name=player_name or "Unknown",
                        rank=ranked_row.rank,
                        stat_value=float(display_value),
                        stat_value_label=(
                            f"{display_value:.1f} {metric_config.per_game_unit}"
                        ),
                    )
                )

            return RoundSpec(
                category_type=CATEGORY_SINGLE_SEASON,
                metric=metric,
                scope_label=(
                    f"{season_year} {metric_config.display_name} per-game leaders"
                ),
                team_id=None,
                season_id=season_id,
                team_code=None,
                team_name=None,
                season_year=season_year,
                slots=tuple(slots),
            )

        raise GuessTheListError(
            "No single-season leaderboard with at least 10 qualified players "
            "was found in the selected range"
        )

    def _ranked_rows_for_candidate(
        self,
        db: Session,
        *,
        season_id: int,
        season_year: int,
        metric_config: SingleSeasonMetricConfig,
    ) -> list[RankedBoundaryItem[SingleSeasonCandidate]]:
        team_game_counts = _team_game_counts_for_season(db, season_id)
        if not team_game_counts:
            return []

        if season_year <= 2006:
            rows = _single_season_rows_from_game_player_stats(
                db,
                season_id=season_id,
                metric_config=metric_config,
                team_game_counts=team_game_counts,
            )
        else:
            rows = _single_season_rows_from_player_season_stats(
                db,
                season_id=season_id,
                metric_config=metric_config,
                team_game_counts=team_game_counts,
            )

        if len(rows) < 10:
            return []

        sorted_rows = sorted(
            rows,
            key=lambda row: (
                -row.average_value,
                (row.last_name or "").casefold(),
                (row.first_name or "").casefold(),
                row.player_id,
            ),
        )
        return ranked_items_with_boundary_ties(
            sorted_rows,
            limit=10,
            stat_value=lambda row: row.average_value,
        )


def _team_game_counts_for_season(db: Session, season_id: int) -> dict[int, int]:
    counts: dict[int, int] = {}
    for team_id, total in (
        db.query(Game.home_team_id, func.count(Game.id))
        .filter(Game.season_id == season_id)
        .group_by(Game.home_team_id)
        .all()
    ):
        counts[team_id] = counts.get(team_id, 0) + int(total or 0)
    for team_id, total in (
        db.query(Game.away_team_id, func.count(Game.id))
        .filter(Game.season_id == season_id)
        .group_by(Game.away_team_id)
        .all()
    ):
        counts[team_id] = counts.get(team_id, 0) + int(total or 0)
    return counts


def _single_season_rows_from_player_season_stats(
    db: Session,
    *,
    season_id: int,
    metric_config: SingleSeasonMetricConfig,
    team_game_counts: Mapping[int, int],
) -> list[SingleSeasonCandidate]:
    appearance_totals = _single_season_appearance_totals_subquery(
        db,
        season_id,
        metric_config,
    )
    metric_total = func.coalesce(
        appearance_totals.c.total_value,
        metric_config.season_column,
        0,
    )
    games_played = func.coalesce(
        appearance_totals.c.appearance_games,
        PlayerSeasonStats.games_played,
    )
    rows = (
        db.query(
            PlayerSeasonTeam.id.label("player_season_team_id"),
            PlayerSeasonTeam.team_id,
            PlayerSeasonTeam.player_id,
            PlayerSeasonTeam.jersey_number,
            Player.first_name,
            Player.last_name,
            Player.position,
            Player.nationality,
            Player.height_cm,
            games_played.label("games_played"),
            metric_total.label("total_value"),
        )
        .select_from(PlayerSeasonStats)
        .join(
            PlayerSeasonTeam,
            PlayerSeasonStats.player_season_team_id == PlayerSeasonTeam.id,
        )
        .join(Player, Player.id == PlayerSeasonTeam.player_id)
        .outerjoin(
            appearance_totals,
            and_(
                appearance_totals.c.player_id == PlayerSeasonTeam.player_id,
                appearance_totals.c.team_id == PlayerSeasonTeam.team_id,
            ),
        )
        .filter(PlayerSeasonTeam.season_id == season_id)
        .filter(games_played > 0)
        .all()
    )
    return _qualified_unique_single_season_rows(rows, team_game_counts)


def _single_season_rows_from_game_player_stats(
    db: Session,
    *,
    season_id: int,
    metric_config: SingleSeasonMetricConfig,
    team_game_counts: Mapping[int, int],
) -> list[SingleSeasonCandidate]:
    appearance_condition = _game_player_stats_counts_as_appearance()
    metric_total = func.coalesce(
        func.sum(case((appearance_condition, metric_config.game_column), else_=0)),
        0,
    )
    games_played = func.count(
        func.distinct(case((appearance_condition, GamePlayerStats.game_id)))
    )
    rows = (
        db.query(
            PlayerSeasonTeam.id.label("player_season_team_id"),
            GamePlayerStats.team_id.label("team_id"),
            GamePlayerStats.player_id.label("player_id"),
            PlayerSeasonTeam.jersey_number,
            Player.first_name,
            Player.last_name,
            Player.position,
            Player.nationality,
            Player.height_cm,
            games_played.label("games_played"),
            metric_total.label("total_value"),
        )
        .select_from(GamePlayerStats)
        .join(Game, Game.id == GamePlayerStats.game_id)
        .join(Player, Player.id == GamePlayerStats.player_id)
        .outerjoin(
            PlayerSeasonTeam,
            and_(
                PlayerSeasonTeam.player_id == GamePlayerStats.player_id,
                PlayerSeasonTeam.team_id == GamePlayerStats.team_id,
                PlayerSeasonTeam.season_id == Game.season_id,
            ),
        )
        .filter(Game.season_id == season_id)
        .group_by(
            PlayerSeasonTeam.id,
            GamePlayerStats.team_id,
            GamePlayerStats.player_id,
            PlayerSeasonTeam.jersey_number,
            Player.first_name,
            Player.last_name,
            Player.position,
            Player.nationality,
            Player.height_cm,
        )
        .having(games_played > 0)
        .all()
    )
    return _qualified_unique_single_season_rows(rows, team_game_counts)


def _single_season_appearance_totals_subquery(
    db: Session,
    season_id: int,
    metric_config: SingleSeasonMetricConfig,
):
    appearance_condition = _game_player_stats_counts_as_appearance()
    return (
        db.query(
            GamePlayerStats.player_id.label("player_id"),
            GamePlayerStats.team_id.label("team_id"),
            func.count(
                func.distinct(case((appearance_condition, GamePlayerStats.game_id)))
            ).label("appearance_games"),
            func.coalesce(
                func.sum(case((appearance_condition, metric_config.game_column), else_=0)),
                0,
            ).label("total_value"),
        )
        .join(Game, Game.id == GamePlayerStats.game_id)
        .filter(Game.season_id == season_id)
        .group_by(GamePlayerStats.player_id, GamePlayerStats.team_id)
        .subquery()
    )


def _game_player_stats_counts_as_appearance():
    return func.upper(func.coalesce(GamePlayerStats.minutes, "")) != "DNP"


def _qualified_unique_single_season_rows(
    rows: Sequence[Any],
    team_game_counts: Mapping[int, int],
) -> list[SingleSeasonCandidate]:
    by_player_id: dict[int, SingleSeasonCandidate] = {}
    for row in rows:
        games_played = int(row.games_played or 0)
        team_game_count = int(team_game_counts.get(row.team_id, 0))
        total_value = Decimal(int(row.total_value or 0))
        if (
            games_played <= 0
            or team_game_count <= 0
            or games_played * 2 < team_game_count
            or total_value <= 0
        ):
            continue

        candidate = SingleSeasonCandidate(
            player_id=row.player_id,
            player_season_team_id=row.player_season_team_id,
            first_name=row.first_name,
            last_name=row.last_name,
            position=row.position,
            nationality=row.nationality,
            height_cm=row.height_cm,
            jersey_number=row.jersey_number,
            games_played=games_played,
            total_value=total_value,
            average_value=total_value / Decimal(games_played),
        )
        previous = by_player_id.get(candidate.player_id)
        if previous is None or _single_season_candidate_is_better(
            candidate,
            previous,
        ):
            by_player_id[candidate.player_id] = candidate

    return list(by_player_id.values())


def _single_season_candidate_is_better(
    candidate: SingleSeasonCandidate,
    previous: SingleSeasonCandidate,
) -> bool:
    return (
        candidate.average_value,
        candidate.games_played,
        candidate.total_value,
        -(candidate.player_season_team_id or 0),
    ) > (
        previous.average_value,
        previous.games_played,
        previous.total_value,
        -(previous.player_season_team_id or 0),
    )


def _round_single_season_average(value: int | float | Decimal) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)


class AllEuroLeagueGenerator:
    def build_round(
        self,
        db: Session,
        game: GuessTheListGame,
        round_number: int,
    ) -> RoundSpec:
        revision = _active_all_euroleague_revision(db)
        metric = revision.enabled_metric
        if metric not in {
            ALL_EUROLEAGUE_METRIC_FIRST,
            ALL_EUROLEAGUE_METRIC_FIRST_SECOND,
        }:
            raise GuessTheListError("All-EuroLeague Teams category is not enabled")

        eligible_metrics = (
            (ALL_EUROLEAGUE_METRIC_FIRST, ALL_EUROLEAGUE_METRIC_SECOND)
            if metric == ALL_EUROLEAGUE_METRIC_FIRST_SECOND
            else (ALL_EUROLEAGUE_METRIC_FIRST,)
        )
        min_slots = (
            ALL_EUROLEAGUE_MIN_FIRST_SECOND_SLOTS
            if metric == ALL_EUROLEAGUE_METRIC_FIRST_SECOND
            else ALL_EUROLEAGUE_MIN_FIRST_SLOTS
        )

        rows = (
            db.query(PlayerAwardSelection, Player, Season)
            .join(Player, Player.id == PlayerAwardSelection.local_player_id)
            .join(Season, Season.id == PlayerAwardSelection.season_id)
            .filter(PlayerAwardSelection.revision_id == revision.id)
            .filter(PlayerAwardSelection.award_key == ALL_EUROLEAGUE_AWARD_KEY)
            .filter(PlayerAwardSelection.award_metric.in_(eligible_metrics))
            .filter(PlayerAwardSelection.status == "accepted")
            .filter(PlayerAwardSelection.local_player_id.isnot(None))
            .filter(Season.year >= game.season_range_start)
            .filter(Season.year <= game.season_range_end)
            .all()
        )
        rows_by_season: dict[int, list[tuple[PlayerAwardSelection, Player, Season]]] = {}
        for selection, player, season in rows:
            rows_by_season.setdefault(season.year, []).append((selection, player, season))

        eligible_years = [
            year
            for year, season_rows in rows_by_season.items()
            if _accepted_unique_player_count(season_rows) >= min_slots
        ]
        if not eligible_years:
            raise GuessTheListError(
                "No All-EuroLeague Teams season with enough accepted selections "
                "was found in the selected range"
            )

        used_years = _used_all_euroleague_seasons(
            db,
            game_id=game.id,
            next_round_number=round_number,
        )
        unused_years = [year for year in eligible_years if year not in used_years]
        chosen_year = random.choice(unused_years or eligible_years)
        chosen_rows = sorted(
            rows_by_season[chosen_year],
            key=lambda item: (
                ALL_EUROLEAGUE_TIER_RANKS.get(item[0].award_metric, 99),
                item[0].source_order,
                item[1].last_name or "",
                item[1].first_name or "",
                item[1].id,
            ),
        )
        season = chosen_rows[0][2]
        slots = []
        for selection, player, _season in chosen_rows:
            player_season_team = _award_player_season_team(db, selection)
            player_name = f"{player.first_name or ''} {player.last_name or ''}".strip()
            slots.append(
                RoundSlotSpec(
                    player_season_team_id=(
                        player_season_team.id if player_season_team is not None else None
                    ),
                    player_id=player.id,
                    jersey_number=(
                        player_season_team.jersey_number
                        if player_season_team is not None
                        else None
                    ),
                    position=player.position,
                    nationality=player.nationality,
                    height_cm=player.height_cm,
                    player_name=player_name or selection.source_player_label,
                    rank=ALL_EUROLEAGUE_TIER_RANKS.get(selection.award_metric),
                    stat_value_label=ALL_EUROLEAGUE_TIER_LABELS.get(
                        selection.award_metric
                    ),
                )
            )

        return RoundSpec(
            category_type=CATEGORY_ALL_EUROLEAGUE,
            metric=metric,
            scope_label=f"All-EuroLeague · {_season_label(season.year)}",
            team_id=None,
            season_id=season.id,
            team_code=None,
            team_name=None,
            season_year=season.year,
            slots=tuple(slots),
        )


class AwardWinnersGenerator:
    def __init__(self, metric: str | None = None):
        if metric is not None and metric not in AWARD_WINNER_METRIC_CONFIGS:
            raise GuessTheListError(f"Unsupported award winners metric: {metric}")
        self._metric = metric

    def build_round(
        self,
        db: Session,
        game: GuessTheListGame,
        round_number: int,
    ) -> RoundSpec:
        candidates_by_metric = self._candidate_windows(db, game)
        if self._metric is not None:
            windows = candidates_by_metric.get(self._metric, [])
            if not windows:
                raise GuessTheListError(
                    "No MVP / Awards window with enough unique winners was found "
                    "in the selected range"
                )
            candidate_metrics = (self._metric,)
        else:
            candidate_metrics = tuple(
                metric for metric, windows in candidates_by_metric.items() if windows
            )
            if not candidate_metrics:
                raise GuessTheListError(
                    "No MVP / Awards window with enough unique winners was found "
                    "in the selected range"
                )

        preferred: dict[str, list[AwardWinnerWindow]] = {}
        fallback: dict[str, list[AwardWinnerWindow]] = {}
        for metric in candidate_metrics:
            windows = candidates_by_metric[metric]
            used_starts = _used_award_window_starts(
                db,
                game_id=game.id,
                next_round_number=round_number,
                metric=metric,
            )
            unused = [window for window in windows if window.season_years[0] not in used_starts]
            if unused:
                preferred[metric] = unused
            fallback[metric] = windows

        choices_by_metric = preferred or fallback
        metric = self._metric or random.choice(tuple(choices_by_metric))
        chosen_window = random.choice(choices_by_metric[metric])
        return self._round_from_window(db, chosen_window)

    def _candidate_windows(
        self,
        db: Session,
        game: GuessTheListGame,
    ) -> dict[str, list[AwardWinnerWindow]]:
        metrics = (
            (self._metric,)
            if self._metric is not None
            else tuple(AWARD_WINNER_METRIC_CONFIGS)
        )
        candidates = {}
        for metric in metrics:
            config = AWARD_WINNER_METRIC_CONFIGS[metric]
            revision = _active_award_winner_revision(db, config.award_key)
            if revision is None:
                candidates[metric] = []
                continue
            rows = (
                db.query(PlayerAwardSelection, Player, Season)
                .join(Player, Player.id == PlayerAwardSelection.local_player_id)
                .join(Season, Season.id == PlayerAwardSelection.season_id)
                .filter(PlayerAwardSelection.revision_id == revision.id)
                .filter(PlayerAwardSelection.award_key == config.award_key)
                .filter(PlayerAwardSelection.award_metric == metric)
                .filter(PlayerAwardSelection.status == "accepted")
                .filter(PlayerAwardSelection.local_player_id.isnot(None))
                .filter(Season.year >= game.season_range_start)
                .filter(Season.year <= game.season_range_end)
                .order_by(Season.year.asc(), PlayerAwardSelection.source_order.asc())
                .all()
            )
            candidates[metric] = _award_winner_windows_for_rows(
                rows,
                metric=metric,
                config=config,
            )
        return candidates

    def _round_from_window(
        self,
        db: Session,
        window: AwardWinnerWindow,
    ) -> RoundSpec:
        slots = []
        for rank, (_player_id, winner_rows) in enumerate(
            window.rows_by_player_id,
            start=1,
        ):
            selection, player, _season = winner_rows[0]
            player_season_team = _award_player_season_team(db, selection)
            player_name = f"{player.first_name or ''} {player.last_name or ''}".strip()
            season_labels = ", ".join(
                _season_label(season.year)
                for _selection, _player, season in winner_rows
            )
            slots.append(
                RoundSlotSpec(
                    player_season_team_id=(
                        player_season_team.id if player_season_team is not None else None
                    ),
                    player_id=player.id,
                    jersey_number=(
                        player_season_team.jersey_number
                        if player_season_team is not None
                        else None
                    ),
                    position=player.position,
                    nationality=player.nationality,
                    height_cm=player.height_cm,
                    player_name=player_name or selection.source_player_label,
                    rank=rank,
                    stat_value=float(winner_rows[0][2].year),
                    stat_value_label=f"{window.config.stat_label}: {season_labels}",
                )
            )

        return RoundSpec(
            category_type=CATEGORY_AWARD_WINNERS,
            metric=window.metric,
            scope_label=(
                f"{window.config.scope_label} · "
                f"{_season_label(window.season_years[0])}-"
                f"{_season_label(window.season_years[-1])}"
            ),
            team_id=None,
            season_id=None,
            team_code=None,
            team_name=None,
            season_year=window.season_years[0],
            slots=tuple(slots),
        )


def _active_award_winner_revision(
    db: Session,
    award_key: str,
) -> AwardDataRevision | None:
    return (
        db.query(AwardDataRevision)
        .filter(AwardDataRevision.award_key == award_key)
        .filter(AwardDataRevision.is_active.is_(True))
        .filter(AwardDataRevision.threshold_passed.is_(True))
        .order_by(AwardDataRevision.created_at.desc(), AwardDataRevision.id.desc())
        .first()
    )


def _award_winner_windows_for_rows(
    rows: Sequence[tuple[PlayerAwardSelection, Player, Season]],
    *,
    metric: str,
    config: AwardWinnerMetricConfig,
) -> list[AwardWinnerWindow]:
    rows_by_year: dict[int, tuple[PlayerAwardSelection, Player, Season]] = {}
    for selection, player, season in rows:
        rows_by_year.setdefault(season.year, (selection, player, season))

    season_years = sorted(rows_by_year)
    windows = []
    for index in range(0, len(season_years) - config.window_size + 1):
        window_years = tuple(season_years[index : index + config.window_size])
        grouped: dict[int, list[tuple[PlayerAwardSelection, Player, Season]]] = {}
        for year in window_years:
            selection, player, season = rows_by_year[year]
            grouped.setdefault(player.id, []).append((selection, player, season))
        if len(grouped) < config.min_unique_winners:
            continue
        rows_by_player_id = tuple(
            (player_id, tuple(grouped_rows))
            for player_id, grouped_rows in sorted(
                grouped.items(),
                key=lambda item: (
                    item[1][0][2].year,
                    item[1][0][1].last_name or "",
                    item[1][0][1].first_name or "",
                    item[0],
                ),
            )
        )
        windows.append(
            AwardWinnerWindow(
                metric=metric,
                config=config,
                season_years=window_years,
                rows_by_player_id=rows_by_player_id,
            )
        )
    return windows


def _used_award_window_starts(
    db: Session,
    *,
    game_id: int,
    next_round_number: int,
    metric: str,
) -> set[int]:
    if next_round_number <= 1:
        return set()
    rows = (
        db.query(GuessTheListRound.season_year)
        .filter(GuessTheListRound.game_id == game_id)
        .filter(GuessTheListRound.category_type == CATEGORY_AWARD_WINNERS)
        .filter(GuessTheListRound.metric == metric)
        .filter(GuessTheListRound.round_number < next_round_number)
        .filter(GuessTheListRound.season_year.isnot(None))
        .all()
    )
    return {int(year) for (year,) in rows if year is not None}


def _active_all_euroleague_revision(db: Session) -> AwardDataRevision:
    revision = (
        db.query(AwardDataRevision)
        .filter(AwardDataRevision.award_key == ALL_EUROLEAGUE_AWARD_KEY)
        .filter(AwardDataRevision.is_active.is_(True))
        .filter(AwardDataRevision.threshold_passed.is_(True))
        .order_by(AwardDataRevision.created_at.desc(), AwardDataRevision.id.desc())
        .first()
    )
    if revision is None:
        raise GuessTheListError("All-EuroLeague Teams category is not enabled")
    return revision


def _accepted_unique_player_count(
    rows: Sequence[tuple[PlayerAwardSelection, Player, Season]],
) -> int:
    return len({selection.local_player_id for selection, _player, _season in rows})


def _used_all_euroleague_seasons(
    db: Session,
    *,
    game_id: int,
    next_round_number: int,
) -> set[int]:
    if next_round_number <= 1:
        return set()
    rows = (
        db.query(GuessTheListRound.season_year)
        .filter(GuessTheListRound.game_id == game_id)
        .filter(GuessTheListRound.category_type == CATEGORY_ALL_EUROLEAGUE)
        .filter(GuessTheListRound.round_number < next_round_number)
        .filter(GuessTheListRound.season_year.isnot(None))
        .all()
    )
    return {int(year) for (year,) in rows if year is not None}


def _award_player_season_team(
    db: Session,
    selection: PlayerAwardSelection,
) -> PlayerSeasonTeam | None:
    if selection.local_player_id is None or selection.season_id is None:
        return None
    query = db.query(PlayerSeasonTeam).filter(
        PlayerSeasonTeam.player_id == selection.local_player_id,
        PlayerSeasonTeam.season_id == selection.season_id,
    )
    if selection.local_team_id is not None:
        team_row = (
            query.filter(PlayerSeasonTeam.team_id == selection.local_team_id)
            .order_by(PlayerSeasonTeam.id.asc())
            .first()
        )
        if team_row is not None:
            return team_row
    return query.order_by(PlayerSeasonTeam.id.asc()).first()


def _season_label(season_year: int) -> str:
    return f"{season_year}/{str(season_year + 1)[-2:]}"


ROUND_GENERATOR_REGISTRY: dict[str, GuessTheListRoundGenerator] = {
    CATEGORY_ALL_EUROLEAGUE: AllEuroLeagueGenerator(),
    CATEGORY_ALL_TIME: AllTimeLeadersGenerator(),
    CATEGORY_AWARD_WINNERS: AwardWinnersGenerator(),
    CATEGORY_ROSTER: RosterGenerator(),
    CATEGORY_SINGLE_SEASON: SingleSeasonLeadersGenerator(),
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


def _uses_randomized_quick_match_rounds(game: GuessTheListGame) -> bool:
    return bool(game.is_race and game.is_public and game.preset)


def _random_quick_match_category() -> str:
    return random.choice(QUICK_MATCH_CATEGORY_TYPES)


def _random_all_time_metric(*, exclude: str | None = None) -> str:
    eligible_metrics = tuple(
        metric for metric in LEADERBOARD_METRICS if metric != exclude
    )
    return random.choice(eligible_metrics or LEADERBOARD_METRICS)


def _previous_all_time_metric(
    db: Session,
    *,
    game_id: int,
    next_round_number: int,
) -> str | None:
    previous_round_number = next_round_number - 1
    if previous_round_number < 1:
        return None

    row = (
        db.query(GuessTheListRound.metric)
        .filter(GuessTheListRound.game_id == game_id)
        .filter(GuessTheListRound.round_number == previous_round_number)
        .filter(GuessTheListRound.category_type == CATEGORY_ALL_TIME)
        .first()
    )
    if row is None or row[0] not in LEADERBOARD_METRICS:
        return None
    return row[0]


def _round_generator_for_next_round(
    db: Session,
    game: GuessTheListGame,
    next_round_number: int,
    *,
    registry: Mapping[str, GuessTheListRoundGenerator] | None = None,
) -> GuessTheListRoundGenerator:
    if not _uses_randomized_quick_match_rounds(game):
        return _generator_for_category(game.category_type, registry=registry)

    category = _random_quick_match_category()
    if category == CATEGORY_ALL_TIME and registry is None:
        return AllTimeLeadersGenerator(
            metric=_random_all_time_metric(
                exclude=_previous_all_time_metric(
                    db,
                    game_id=game.id,
                    next_round_number=next_round_number,
                )
            )
        )
    return _generator_for_category(category, registry=registry)


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
    generator = _round_generator_for_next_round(
        db,
        game,
        next_round_number,
        registry=registry,
    )
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
