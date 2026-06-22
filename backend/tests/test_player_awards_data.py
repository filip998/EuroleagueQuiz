from pathlib import Path

from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.models import AwardDataRevision, PlayerAwardSelection
from app.services.guess_the_list import (
    AWARD_WINNER_FINAL_FOUR_MVP,
    AWARD_WINNER_REGULAR_SEASON_MVP,
)


def test_tracked_database_has_active_mvp_award_winner_revisions():
    db_path = Path(__file__).resolve().parents[1] / "data" / "euroleague.db"
    engine = create_engine(f"sqlite:///{db_path}")
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        expected = {
            AWARD_WINNER_REGULAR_SEASON_MVP: [
                year for year in range(2004, 2026) if year != 2019
            ],
            AWARD_WINNER_FINAL_FOUR_MVP: [
                year for year in range(2000, 2026) if year != 2019
            ],
        }
        for metric, expected_years in expected.items():
            revision = (
                session.query(AwardDataRevision)
                .filter(AwardDataRevision.award_key == metric)
                .filter(AwardDataRevision.is_active.is_(True))
                .filter(AwardDataRevision.threshold_passed.is_(True))
                .one()
            )
            assert revision.enabled_metric == metric
            assert revision.source_revision_id
            assert revision.content_hash
            assert revision.eligible_round_count >= 1

            rows = (
                session.query(
                    PlayerAwardSelection.season_year,
                    func.count(PlayerAwardSelection.id),
                    func.count(func.distinct(PlayerAwardSelection.local_player_id)),
                )
                .filter(PlayerAwardSelection.revision_id == revision.id)
                .filter(PlayerAwardSelection.status == "accepted")
                .group_by(PlayerAwardSelection.season_year)
                .order_by(PlayerAwardSelection.season_year)
                .all()
            )
            assert [year for year, _count, _players in rows] == expected_years
            assert all(count == 1 for _year, count, _players in rows)
            assert all(players == 1 for _year, _count, players in rows)

            not_awarded = (
                session.query(PlayerAwardSelection)
                .filter(PlayerAwardSelection.revision_id == revision.id)
                .filter(PlayerAwardSelection.season_year == 2019)
                .filter(PlayerAwardSelection.status == "excluded")
                .filter(PlayerAwardSelection.match_method == "not_awarded")
                .count()
            )
            assert not_awarded == 1

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
