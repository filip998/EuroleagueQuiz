from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import Game, Player, PlayerSeasonTeam, Season, Team
from ingestion.champions import (
    ChampionSeason,
    champion_counts_by_season,
    enrich_champion_flags,
    parse_euroleague_game_date,
)


@pytest.fixture()
def champion_session(tmp_path):
    db_path = tmp_path / "champions.db"
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


def _add_player_season_team(
    session,
    *,
    code: str,
    team: Team,
    season: Season,
    registration_start: date | None = None,
    registration_end: date | None = None,
) -> PlayerSeasonTeam:
    player = Player(euroleague_code=code, first_name=code, last_name="Player")
    session.add(player)
    session.flush()

    row = PlayerSeasonTeam(
        player_id=player.id,
        team_id=team.id,
        season_id=season.id,
        registration_start=registration_start,
        registration_end=registration_end,
    )
    session.add(row)
    session.flush()
    return row


def test_champion_enrichment_uses_title_squad_rule_and_is_idempotent(
    champion_session,
):
    season = Season(year=2024, name="2024-2025")
    champion = Team(euroleague_code="TIT", name="Title Team", short_name="Title")
    other_team = Team(euroleague_code="OTH", name="Other Team", short_name="Other")
    champion_session.add_all([season, champion, other_team])
    champion_session.flush()

    full_season = _add_player_season_team(
        champion_session,
        code="FULL",
        team=champion,
        season=season,
        registration_end=None,
    )
    departure = _add_player_season_team(
        champion_session,
        code="LEFT",
        team=champion,
        season=season,
        registration_end=date(2025, 1, 15),
    )
    signing = _add_player_season_team(
        champion_session,
        code="SIGN",
        team=champion,
        season=season,
        registration_start=date(2025, 2, 1),
        registration_end=date(2025, 6, 30),
    )
    opponent = _add_player_season_team(
        champion_session,
        code="OPPO",
        team=other_team,
        season=season,
        registration_end=None,
    )
    champion_session.add_all(
        [
            Game(
                season_id=season.id,
                euroleague_gamecode=1,
                phase="FF",
                game_date="May 23, 2025",
                home_team_id=champion.id,
                away_team_id=other_team.id,
            ),
            Game(
                season_id=season.id,
                euroleague_gamecode=2,
                phase="FF",
                game_date="May 25, 2025",
                home_team_id=champion.id,
                away_team_id=other_team.id,
            ),
        ]
    )
    champion_session.flush()

    champion_map = {
        2024: ChampionSeason("TIT", ("Title",)),
    }
    first_reports = enrich_champion_flags(
        champion_session,
        start_year=2024,
        end_year=2024,
        champion_seasons=champion_map,
    )
    champion_session.flush()

    assert champion_counts_by_season(first_reports) == {2024: 2}
    assert first_reports[0].final_four_date == date(2025, 5, 25)
    assert first_reports[0].set_true_count == 2
    assert first_reports[0].set_false_count == 0
    assert season.champion_team_id == champion.id

    champion_session.refresh(full_season)
    champion_session.refresh(departure)
    champion_session.refresh(signing)
    champion_session.refresh(opponent)
    assert full_season.is_champion is True
    assert departure.is_champion is False
    assert signing.is_champion is True
    assert opponent.is_champion is False

    second_reports = enrich_champion_flags(
        champion_session,
        start_year=2024,
        end_year=2024,
        champion_seasons=champion_map,
    )
    champion_session.flush()

    assert champion_counts_by_season(second_reports) == {2024: 2}
    assert second_reports[0].set_true_count == 0
    assert second_reports[0].set_false_count == 0


def test_champion_enrichment_uses_explicit_fallback_for_2000(champion_session):
    season = Season(year=2000, name="2000-2001")
    champion = Team(euroleague_code="VIR", name="Virtus", short_name="Virtus Bologna")
    champion_session.add_all([season, champion])
    champion_session.flush()

    included = _add_player_season_team(
        champion_session,
        code="VIR1",
        team=champion,
        season=season,
        registration_end=date(2001, 6, 30),
    )
    excluded = _add_player_season_team(
        champion_session,
        code="VIR2",
        team=champion,
        season=season,
        registration_end=date(2001, 1, 1),
    )

    reports = enrich_champion_flags(
        champion_session,
        start_year=2000,
        end_year=2000,
    )
    champion_session.flush()

    assert champion_counts_by_season(reports) == {2000: 1}
    assert reports[0].final_four_date == date(2001, 6, 30)
    champion_session.refresh(included)
    champion_session.refresh(excluded)
    assert included.is_champion is True
    assert excluded.is_champion is False


def test_champion_enrichment_skips_missing_final_four_date_without_fallback(
    champion_session,
):
    season = Season(year=2025, name="2025-2026")
    champion = Team(euroleague_code="OLY", name="Olympiacos", short_name="Olympiacos")
    champion_session.add_all([season, champion])
    champion_session.flush()
    row = _add_player_season_team(
        champion_session,
        code="OLY1",
        team=champion,
        season=season,
        registration_end=None,
    )

    reports = enrich_champion_flags(
        champion_session,
        start_year=2025,
        end_year=2025,
    )
    champion_session.flush()

    assert champion_counts_by_season(reports) == {2025: 0}
    assert reports[0].skipped_reason == "final_four_date_missing"
    assert season.champion_team_id == champion.id
    champion_session.refresh(row)
    assert row.is_champion is False


def test_parse_euroleague_game_date_is_locale_independent():
    assert parse_euroleague_game_date("Apr 30, 2006") == date(2006, 4, 30)
    assert parse_euroleague_game_date("May 5, 2002") == date(2002, 5, 5)
