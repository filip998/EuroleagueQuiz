from dataclasses import dataclass
from typing import Iterable, Literal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    GamePlayerStats,
    PlayerSeasonStats,
    PlayerSeasonTeam,
    QuizTicTacToeStatMilestonePlayer,
)

STAT_MILESTONE_MIN_SEASON_GAMES = 10
STAT_MILESTONE_MIN_ELIGIBLE_PLAYERS = 40

StatMilestoneFamily = Literal["season_average", "single_game", "career_total"]


@dataclass(frozen=True)
class StatMilestoneDefinition:
    key: str
    family: StatMilestoneFamily
    stat_column: str
    threshold: int
    display_label: str

    def __post_init__(self) -> None:
        if not isinstance(self.threshold, int) or self.threshold <= 0:
            raise ValueError("stat milestone thresholds must be positive integers")


SHIPPED_STAT_MILESTONE_DEFINITIONS: tuple[StatMilestoneDefinition, ...] = (
    StatMilestoneDefinition(
        key="season_15_ppg",
        family="season_average",
        stat_column="points",
        threshold=15,
        display_label="15+ PPG season",
    ),
    StatMilestoneDefinition(
        key="season_6_rpg",
        family="season_average",
        stat_column="total_rebounds",
        threshold=6,
        display_label="6+ RPG season",
    ),
    StatMilestoneDefinition(
        key="season_5_apg",
        family="season_average",
        stat_column="assists",
        threshold=5,
        display_label="5+ APG season",
    ),
    StatMilestoneDefinition(
        key="season_15_pir",
        family="season_average",
        stat_column="pir",
        threshold=15,
        display_label="15+ PIR season",
    ),
    StatMilestoneDefinition(
        key="game_30_points",
        family="single_game",
        stat_column="points",
        threshold=30,
        display_label="30+ points in a game",
    ),
    StatMilestoneDefinition(
        key="career_1000_points",
        family="career_total",
        stat_column="points",
        threshold=1000,
        display_label="1,000+ career points",
    ),
)

OPTIONAL_STAT_MILESTONE_DEFINITIONS: tuple[StatMilestoneDefinition, ...] = (
    StatMilestoneDefinition(
        key="career_3000_points",
        family="career_total",
        stat_column="points",
        threshold=3000,
        display_label="3,000+ career points",
    ),
)

STAT_MILESTONE_DEFINITIONS_BY_KEY: dict[str, StatMilestoneDefinition] = {
    definition.key: definition
    for definition in (
        *SHIPPED_STAT_MILESTONE_DEFINITIONS,
        *OPTIONAL_STAT_MILESTONE_DEFINITIONS,
    )
}

_SEASON_STAT_COLUMNS = {
    "points": PlayerSeasonStats.points,
    "total_rebounds": PlayerSeasonStats.total_rebounds,
    "assists": PlayerSeasonStats.assists,
    "pir": PlayerSeasonStats.pir,
}
_GAME_STAT_COLUMNS = {
    "points": GamePlayerStats.points,
}


def _coerce_unique_definitions(
    definitions: Iterable[StatMilestoneDefinition],
) -> tuple[StatMilestoneDefinition, ...]:
    definition_tuple = tuple(definitions)
    keys = [definition.key for definition in definition_tuple]
    if len(keys) != len(set(keys)):
        raise ValueError("stat milestone definitions must have unique keys")
    return definition_tuple


def eligible_player_ids_for_stat_milestone(
    db: Session,
    definition: StatMilestoneDefinition,
) -> set[int]:
    if definition.family == "season_average":
        return _eligible_player_ids_for_season_average(db, definition)
    if definition.family == "single_game":
        return _eligible_player_ids_for_single_game(db, definition)
    if definition.family == "career_total":
        return _eligible_player_ids_for_career_total(db, definition)
    raise ValueError(f"Unsupported stat milestone family: {definition.family}")


def compute_stat_milestone_counts(
    db: Session,
    definitions: Iterable[StatMilestoneDefinition] = SHIPPED_STAT_MILESTONE_DEFINITIONS,
) -> dict[str, int]:
    definition_tuple = _coerce_unique_definitions(definitions)
    return {
        definition.key: len(eligible_player_ids_for_stat_milestone(db, definition))
        for definition in definition_tuple
    }


def build_stat_milestone_eligibility(
    db: Session,
    definitions: Iterable[StatMilestoneDefinition] = SHIPPED_STAT_MILESTONE_DEFINITIONS,
) -> dict[str, int]:
    definition_tuple = _coerce_unique_definitions(definitions)
    milestone_keys = [definition.key for definition in definition_tuple]
    if not milestone_keys:
        return {}

    eligible_by_key = {
        definition.key: eligible_player_ids_for_stat_milestone(db, definition)
        for definition in definition_tuple
    }

    (
        db.query(QuizTicTacToeStatMilestonePlayer)
        .filter(QuizTicTacToeStatMilestonePlayer.milestone_key.in_(milestone_keys))
        .delete(synchronize_session=False)
    )

    rows = [
        QuizTicTacToeStatMilestonePlayer(
            milestone_key=milestone_key,
            player_id=player_id,
        )
        for milestone_key, player_ids in eligible_by_key.items()
        for player_id in sorted(player_ids)
    ]
    if rows:
        db.add_all(rows)
    db.flush()
    return {
        milestone_key: len(player_ids)
        for milestone_key, player_ids in eligible_by_key.items()
    }


def get_precomputed_stat_milestone_player_ids(
    db: Session,
    milestone_key: str,
) -> set[int]:
    rows = (
        db.query(QuizTicTacToeStatMilestonePlayer.player_id)
        .filter(QuizTicTacToeStatMilestonePlayer.milestone_key == milestone_key)
        .all()
    )
    return {row.player_id for row in rows}


def _season_stat_column(definition: StatMilestoneDefinition):
    try:
        return _SEASON_STAT_COLUMNS[definition.stat_column]
    except KeyError as exc:
        raise ValueError(
            f"Unsupported season stat milestone column: {definition.stat_column}"
        ) from exc


def _game_stat_column(definition: StatMilestoneDefinition):
    try:
        return _GAME_STAT_COLUMNS[definition.stat_column]
    except KeyError as exc:
        raise ValueError(
            f"Unsupported game stat milestone column: {definition.stat_column}"
        ) from exc


def _eligible_player_ids_for_season_average(
    db: Session,
    definition: StatMilestoneDefinition,
) -> set[int]:
    stat_column = _season_stat_column(definition)
    rows = (
        db.query(PlayerSeasonTeam.player_id)
        .join(
            PlayerSeasonStats,
            PlayerSeasonStats.player_season_team_id == PlayerSeasonTeam.id,
        )
        .filter(PlayerSeasonStats.games_played >= STAT_MILESTONE_MIN_SEASON_GAMES)
        .filter(stat_column >= definition.threshold * PlayerSeasonStats.games_played)
        .distinct()
        .all()
    )
    return {row.player_id for row in rows}


def _eligible_player_ids_for_single_game(
    db: Session,
    definition: StatMilestoneDefinition,
) -> set[int]:
    stat_column = _game_stat_column(definition)
    rows = (
        db.query(GamePlayerStats.player_id)
        .filter(stat_column >= definition.threshold)
        .distinct()
        .all()
    )
    return {row.player_id for row in rows}


def _eligible_player_ids_for_career_total(
    db: Session,
    definition: StatMilestoneDefinition,
) -> set[int]:
    stat_column = _season_stat_column(definition)
    career_totals = (
        db.query(
            PlayerSeasonTeam.player_id.label("player_id"),
            func.sum(stat_column).label("career_total"),
        )
        .join(
            PlayerSeasonStats,
            PlayerSeasonStats.player_season_team_id == PlayerSeasonTeam.id,
        )
        .group_by(PlayerSeasonTeam.player_id)
        .subquery()
    )
    rows = (
        db.query(career_totals.c.player_id)
        .filter(career_totals.c.career_total >= definition.threshold)
        .all()
    )
    return {row.player_id for row in rows}
