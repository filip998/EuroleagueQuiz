from pathlib import Path

from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.models import AwardDataRevision, PlayerAwardSelection
from app.services.guess_the_list import (
    ALL_EUROLEAGUE_AWARD_KEY,
    ALL_EUROLEAGUE_METRIC_FIRST,
    ALL_EUROLEAGUE_METRIC_SECOND,
)


def test_tracked_database_has_active_all_euroleague_first_second_revision():
    db_path = Path(__file__).resolve().parents[1] / "data" / "euroleague.db"
    engine = create_engine(f"sqlite:///{db_path}")
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        revision = (
            session.query(AwardDataRevision)
            .filter(AwardDataRevision.award_key == ALL_EUROLEAGUE_AWARD_KEY)
            .filter(AwardDataRevision.is_active.is_(True))
            .filter(AwardDataRevision.threshold_passed.is_(True))
            .one()
        )
        assert revision.enabled_metric == "first_second"

        rows = (
            session.query(
                PlayerAwardSelection.season_year,
                func.count(PlayerAwardSelection.id),
                func.count(func.distinct(PlayerAwardSelection.local_player_id)),
            )
            .filter(PlayerAwardSelection.revision_id == revision.id)
            .filter(PlayerAwardSelection.status == "accepted")
            .filter(
                PlayerAwardSelection.award_metric.in_(
                    [ALL_EUROLEAGUE_METRIC_FIRST, ALL_EUROLEAGUE_METRIC_SECOND]
                )
            )
            .group_by(PlayerAwardSelection.season_year)
            .order_by(PlayerAwardSelection.season_year)
            .all()
        )
        expected_years = [year for year in range(2000, 2026) if year != 2019]
        assert [year for year, _count, _players in rows] == expected_years
        assert all(distinct_players >= 10 for _year, _count, distinct_players in rows)
        assert sum(count for _year, count, _players in rows) == 251
        unresolved_teams = (
            session.query(PlayerAwardSelection)
            .filter(PlayerAwardSelection.revision_id == revision.id)
            .filter(PlayerAwardSelection.status == "accepted")
            .filter(PlayerAwardSelection.source_team_label.isnot(None))
            .filter(PlayerAwardSelection.local_team_id.is_(None))
            .count()
        )
        assert unresolved_teams == 0
    finally:
        session.close()
        engine.dispose()
