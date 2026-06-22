from pathlib import Path

from sqlalchemy import and_, create_engine, func
from sqlalchemy.orm import sessionmaker

from app.models import PlayerSeasonTeam, Season
from app.services.guess_the_list import MIN_ROSTER_SIZE


def test_tracked_database_has_playable_champion_roster_coverage():
    db_path = Path(__file__).resolve().parents[1] / "data" / "euroleague.db"
    engine = create_engine(f"sqlite:///{db_path}")
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        rows = (
            session.query(
                Season.year,
                Season.champion_team_id,
                func.count(PlayerSeasonTeam.id),
            )
            .outerjoin(
                PlayerSeasonTeam,
                and_(
                    PlayerSeasonTeam.season_id == Season.id,
                    PlayerSeasonTeam.team_id == Season.champion_team_id,
                    PlayerSeasonTeam.is_champion.is_(True),
                ),
            )
            .filter(Season.year >= 2000)
            .filter(Season.year <= 2025)
            .group_by(Season.year, Season.champion_team_id)
            .order_by(Season.year)
            .all()
        )
        rows_by_year = {
            year: {
                "champion_team_id": champion_team_id,
                "flagged_count": int(flagged_count),
            }
            for year, champion_team_id, flagged_count in rows
        }

        playable_years = [
            year
            for year, row in rows_by_year.items()
            if row["champion_team_id"] is not None
            and row["flagged_count"] >= MIN_ROSTER_SIZE
        ]
        expected_playable_years = [year for year in range(2000, 2025) if year != 2019]

        assert playable_years == expected_playable_years
        assert rows_by_year[2019]["champion_team_id"] is None
        assert rows_by_year[2019]["flagged_count"] == 0

        # Intentional tripwire: when 2025-26 Final Four roster data is ingested,
        # update this expectation and include the new tracked DB artifact.
        assert rows_by_year[2025]["champion_team_id"] is not None
        assert rows_by_year[2025]["flagged_count"] < MIN_ROSTER_SIZE

        playable_counts = [rows_by_year[year]["flagged_count"] for year in playable_years]
        assert min(playable_counts) >= 13
        assert max(playable_counts) <= 18
    finally:
        session.close()
        engine.dispose()
