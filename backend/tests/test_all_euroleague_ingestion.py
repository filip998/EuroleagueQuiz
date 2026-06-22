from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import AwardDataRevision, Player, PlayerAwardSelection, Season, Team
from ingestion.all_euroleague import (
    METRIC_FIRST,
    METRIC_FIRST_SECOND,
    WikipediaAwardPage,
    IngestOptions,
    ingest_all_euroleague,
    parse_all_euroleague_selections,
)


class FakeAllEuroLeagueAdapter:
    def __init__(self, wikitext: str):
        self.wikitext = wikitext

    def fetch_page(self) -> WikipediaAwardPage:
        return WikipediaAwardPage(
            page_id=123,
            title="All-EuroLeague Team",
            url="https://en.wikipedia.org/wiki/All-EuroLeague_Team",
            revision_id="fixture-revision",
            wikitext=self.wikitext,
            retrieved_at=datetime.utcnow(),
        )


@pytest.fixture()
def session():
    engine = create_engine("sqlite:///:memory:")
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()
        engine.dispose()


def _all_euroleague_table(
    *,
    bad_second_team: bool = False,
    first_one_team: str = "Alpha Club",
    second_one_team: str = "Alpha Club",
) -> str:
    second_five = "Missing Five" if bad_second_team else "Second Five"
    return f"""
{{|| class="wikitable "
|-
! Seasons !! Ref. !! Pos. !! colspan=2 |All-EuroLeague First Team !! colspan=2 | All-EuroLeague Second Team
|-
! Player !! Club !! Player !! Club
|-
|rowspan=5 | [[2006–07 Euroleague|2006–07]]
|rowspan=5 |
| [[Point guard|PG]]
| [[First One]]<br>[[First Tie]]
| [[{first_one_team}]]<br>[[Alpha Club]]
| [[Second One]]
| [[{second_one_team}]]
|-
| [[Shooting guard|SG]]
| [[First Two]]
| [[Alpha Club]]
| [[Second Two]]
| [[Alpha Club]]
|-
| [[Small forward|SF]]
| [[First Three]]
| [[Alpha Club]]
| [[Second Three]]
| [[Alpha Club]]
|-
| [[Power forward (basketball)|PF]]
| [[First Four]]
| [[Alpha Club]]
| [[Second Four]]
| [[Alpha Club]]
|-
| [[Center (basketball)|C]]
| [[First Five]]
| [[Alpha Club]]
| [[{second_five}]]
| [[Alpha Club]]
|}}
"""


def _seed_award_fixture(session, *, include_second_five: bool = True) -> None:
    season = Season(year=2006, name="2006-2007")
    team = Team(euroleague_code="ALP", name="Alpha Club", short_name="Alpha")
    wro_team = Team(euroleague_code="WRO", name="IDEA SLASK", short_name="Slask")
    session.add_all([season, team, wro_team])
    session.flush()
    labels = [
        "First One",
        "First Tie",
        "First Two",
        "First Three",
        "First Four",
        "First Five",
        "Second One",
        "Second Two",
        "Second Three",
        "Second Four",
    ]
    if include_second_five:
        labels.append("Second Five")
    for index, label in enumerate(labels, start=1):
        first_name, last_name = label.split(" ", 1)
        session.add(
            Player(
                euroleague_code=f"ALE{index:03}",
                first_name=first_name,
                last_name=last_name,
                nationality="Country",
                position="Guard",
                height_cm=180 + index,
            )
        )
    session.commit()


def test_parse_all_euroleague_splits_2006_first_team_tie():
    rows = parse_all_euroleague_selections(_all_euroleague_table())

    assert len(rows) == 11
    first_team = [row for row in rows if row.award_metric == METRIC_FIRST]
    assert len(first_team) == 6
    assert [row.source_player_label for row in first_team[:2]] == [
        "First One",
        "First Tie",
    ]
    assert first_team[0].source_row_key != first_team[1].source_row_key


def test_ingest_all_euroleague_activates_first_second_with_report(
    session,
    tmp_path: Path,
):
    _seed_award_fixture(session)
    report_path = tmp_path / "all-euroleague-report.json"

    report = ingest_all_euroleague(
        session,
        FakeAllEuroLeagueAdapter(_all_euroleague_table()),
        IngestOptions(
            start_year=2006,
            end_year=2006,
            overrides_path=None,
            report_path=report_path,
        ),
    )
    session.commit()

    assert report.threshold_passed is True
    assert report.enabled_metric == METRIC_FIRST_SECOND
    assert report.first_second is not None
    assert report.first_second.playable_seasons == [2006]
    assert report_path.exists()

    revision = session.query(AwardDataRevision).one()
    assert revision.is_active is True
    assert revision.enabled_metric == METRIC_FIRST_SECOND
    assert revision.accepted_row_count == 11
    assert session.query(PlayerAwardSelection).count() == 11


def test_ingest_all_euroleague_falls_back_to_first_team_when_second_unresolved(
    session,
):
    _seed_award_fixture(session, include_second_five=False)

    report = ingest_all_euroleague(
        session,
        FakeAllEuroLeagueAdapter(_all_euroleague_table(bad_second_team=True)),
        IngestOptions(start_year=2006, end_year=2006, overrides_path=None),
    )
    session.commit()

    revision = session.query(AwardDataRevision).one()
    assert report.first_second is not None
    assert report.first_second.passed is False
    assert report.first is not None
    assert report.first.passed is True
    assert report.threshold_passed is True
    assert revision.is_active is True
    assert revision.enabled_metric == METRIC_FIRST


def test_ingest_all_euroleague_uses_reviewed_accented_team_alias(
    session,
    tmp_path: Path,
):
    _seed_award_fixture(session)
    overrides_path = tmp_path / "overrides.json"
    overrides_path.write_text(
        '{"team_aliases": {"Śląsk Wrocław": "WRO"}}',
        encoding="utf-8",
    )

    report = ingest_all_euroleague(
        session,
        FakeAllEuroLeagueAdapter(
            _all_euroleague_table(second_one_team="Śląsk Wrocław"),
        ),
        IngestOptions(
            start_year=2006,
            end_year=2006,
            overrides_path=overrides_path,
        ),
    )
    session.commit()

    wro_team = session.query(Team).filter(Team.euroleague_code == "WRO").one()
    selection = (
        session.query(PlayerAwardSelection)
        .filter(PlayerAwardSelection.source_team_label == "Śląsk Wrocław")
        .one()
    )
    assert report.threshold_passed is True
    assert report.team_unmatched == 0
    assert selection.local_team_id == wro_team.id


def test_ingest_all_euroleague_does_not_activate_with_unresolved_team_mapping(
    session,
):
    _seed_award_fixture(session)

    report = ingest_all_euroleague(
        session,
        FakeAllEuroLeagueAdapter(_all_euroleague_table(first_one_team="Unknown Club")),
        IngestOptions(start_year=2006, end_year=2006, overrides_path=None),
    )
    session.commit()

    revision = session.query(AwardDataRevision).one()
    assert report.threshold_passed is False
    assert report.first_second is not None
    assert report.first_second.seasons["2006"]["team_unresolved"] == 1
    assert report.first is not None
    assert report.first.seasons["2006"]["team_unresolved"] == 1
    assert revision.is_active is False
    assert revision.enabled_metric is None
