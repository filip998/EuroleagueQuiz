from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import (
    Game,
    GamePlayerStats,
    Player,
    PlayerSeasonStats,
    PlayerSeasonTeam,
    QuizTicTacToeStatMilestonePlayer,
    Season,
    Team,
)
from app.services.tictactoe_stat_milestones import (
    SHIPPED_STAT_MILESTONE_DEFINITIONS,
    STAT_MILESTONE_DEFINITIONS_BY_KEY,
    STAT_MILESTONE_MIN_ELIGIBLE_PLAYERS,
    build_stat_milestone_eligibility,
    eligible_player_ids_for_stat_milestone,
    get_precomputed_stat_milestone_player_ids,
)

TEST_DATABASE_URL = "sqlite:///data/euroleague.db"


@pytest.fixture()
def milestone_session(tmp_path: Path):
    db_path = tmp_path / "ttt_stat_milestones.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def tracked_db_session():
    engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _add_player(session, code: str, first_name: str, last_name: str) -> Player:
    player = Player(euroleague_code=code, first_name=first_name, last_name=last_name)
    session.add(player)
    session.flush()
    return player


def _add_stats(
    session,
    *,
    player: Player,
    team: Team,
    season: Season,
    games_played: int,
    points: int = 0,
    rebounds: int = 0,
    assists: int = 0,
    pir: int = 0,
) -> PlayerSeasonTeam:
    stint = PlayerSeasonTeam(
        player_id=player.id,
        team_id=team.id,
        season_id=season.id,
    )
    session.add(stint)
    session.flush()
    session.add(
        PlayerSeasonStats(
            player_season_team_id=stint.id,
            games_played=games_played,
            points=points,
            total_rebounds=rebounds,
            assists=assists,
            pir=pir,
        )
    )
    session.flush()
    return stint


def _shipped_rows(session) -> set[tuple[str, int]]:
    shipped_keys = [definition.key for definition in SHIPPED_STAT_MILESTONE_DEFINITIONS]
    rows = (
        session.query(
            QuizTicTacToeStatMilestonePlayer.milestone_key,
            QuizTicTacToeStatMilestonePlayer.player_id,
        )
        .filter(QuizTicTacToeStatMilestonePlayer.milestone_key.in_(shipped_keys))
        .all()
    )
    return {(row.milestone_key, row.player_id) for row in rows}


def test_stat_milestone_precompute_is_idempotent_and_uses_calibrated_semantics(
    milestone_session,
):
    season_2024 = Season(year=2024, name="2024-2025")
    season_2025 = Season(year=2025, name="2025-2026")
    team_a = Team(euroleague_code="MSA", name="Milestone A")
    team_b = Team(euroleague_code="MSB", name="Milestone B")
    milestone_session.add_all([season_2024, season_2025, team_a, team_b])
    milestone_session.flush()

    exact_ppg = _add_player(milestone_session, "MSP001", "Exact", "Threshold")
    below_ppg = _add_player(milestone_session, "MSP002", "Below", "Threshold")
    too_few_games = _add_player(milestone_session, "MSP003", "TooFew", "Games")
    split_stint = _add_player(milestone_session, "MSP004", "Split", "Season")
    game_scorer = _add_player(milestone_session, "MSP005", "Game", "Scorer")
    career_scorer = _add_player(milestone_session, "MSP006", "Career", "Scorer")

    _add_stats(
        milestone_session,
        player=exact_ppg,
        team=team_a,
        season=season_2024,
        games_played=10,
        points=150,
    )
    _add_stats(
        milestone_session,
        player=below_ppg,
        team=team_a,
        season=season_2024,
        games_played=10,
        points=149,
    )
    _add_stats(
        milestone_session,
        player=too_few_games,
        team=team_a,
        season=season_2024,
        games_played=9,
        points=200,
    )
    _add_stats(
        milestone_session,
        player=split_stint,
        team=team_a,
        season=season_2024,
        games_played=8,
        points=120,
    )
    _add_stats(
        milestone_session,
        player=split_stint,
        team=team_b,
        season=season_2024,
        games_played=8,
        points=120,
    )
    _add_stats(
        milestone_session,
        player=career_scorer,
        team=team_a,
        season=season_2024,
        games_played=40,
        points=500,
    )
    _add_stats(
        milestone_session,
        player=career_scorer,
        team=team_b,
        season=season_2025,
        games_played=40,
        points=500,
    )

    game = Game(
        season_id=season_2024.id,
        euroleague_gamecode=1,
        home_team_id=team_a.id,
        away_team_id=team_b.id,
    )
    milestone_session.add(game)
    milestone_session.flush()
    milestone_session.add_all(
        [
            GamePlayerStats(
                game_id=game.id,
                player_id=game_scorer.id,
                team_id=team_a.id,
                points=30,
            ),
            GamePlayerStats(
                game_id=game.id,
                player_id=below_ppg.id,
                team_id=team_b.id,
                points=29,
            ),
        ]
    )
    milestone_session.flush()

    ppg_definition = STAT_MILESTONE_DEFINITIONS_BY_KEY["season_15_ppg"]
    ppg_ids = eligible_player_ids_for_stat_milestone(
        milestone_session,
        ppg_definition,
    )
    assert exact_ppg.id in ppg_ids
    assert below_ppg.id not in ppg_ids
    assert too_few_games.id not in ppg_ids
    assert split_stint.id not in ppg_ids

    first_counts = build_stat_milestone_eligibility(milestone_session)
    first_rows = _shipped_rows(milestone_session)

    assert first_counts["season_15_ppg"] == 1
    assert first_counts["game_30_points"] == 1
    assert first_counts["career_1000_points"] == 1
    assert get_precomputed_stat_milestone_player_ids(
        milestone_session,
        "season_15_ppg",
    ) == {exact_ppg.id}

    milestone_session.add(
        QuizTicTacToeStatMilestonePlayer(
            milestone_key="manual_future_key",
            player_id=below_ppg.id,
        )
    )
    milestone_session.flush()

    second_counts = build_stat_milestone_eligibility(milestone_session)
    second_rows = _shipped_rows(milestone_session)

    assert second_counts == first_counts
    assert second_rows == first_rows
    assert (
        milestone_session.query(QuizTicTacToeStatMilestonePlayer)
        .filter_by(milestone_key="manual_future_key", player_id=below_ppg.id)
        .first()
        is not None
    )


def test_tracked_stat_milestone_thresholds_meet_calibration_guard(tracked_db_session):
    for definition in SHIPPED_STAT_MILESTONE_DEFINITIONS:
        player_ids = eligible_player_ids_for_stat_milestone(
            tracked_db_session,
            definition,
        )
        assert len(player_ids) >= STAT_MILESTONE_MIN_ELIGIBLE_PLAYERS, definition.key


def test_tracked_stat_milestone_table_matches_recomputed_memberships(tracked_db_session):
    for definition in SHIPPED_STAT_MILESTONE_DEFINITIONS:
        expected = eligible_player_ids_for_stat_milestone(
            tracked_db_session,
            definition,
        )
        persisted = get_precomputed_stat_milestone_player_ids(
            tracked_db_session,
            definition.key,
        )
        assert persisted == expected, definition.key
