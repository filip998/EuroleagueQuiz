from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import AwardDataRevision, Player, PlayerAwardSelection, Season, Team
from ingestion.player_awards import (
    FINAL_FOUR_MVP,
    REGULAR_SEASON_MVP,
    PlayerAwardsIngestOptions,
    WikipediaAwardPage,
    ingest_player_awards,
    parse_player_award_winners,
)


class FakePlayerAwardsAdapter:
    def __init__(self, pages: dict[str, str]):
        self.pages = pages

    def fetch_pages(self, metrics: tuple[str, ...]) -> dict[str, WikipediaAwardPage]:
        return {
            metric: WikipediaAwardPage(
                page_id=100 + index,
                title=metric,
                url=f"https://example.test/{metric}",
                revision_id=f"{metric}-fixture-revision",
                wikitext=self.pages[metric],
                retrieved_at=datetime.utcnow(),
            )
            for index, metric in enumerate(metrics, start=1)
        }


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


def _seed_award_players(session, *, years: range, labels: list[str]) -> None:
    alpha = Team(euroleague_code="ALP", name="Alpha Club", short_name="Alpha")
    kinder = Team(euroleague_code="VIR", name="Kinder Bologna", short_name="Kinder")
    session.add_all([alpha, kinder])
    for year in years:
        session.add(Season(year=year, name=f"{year}-{year + 1}"))
    session.flush()
    for index, label in enumerate(labels, start=1):
        first_name, last_name = label.split(" ", 1)
        session.add(
            Player(
                euroleague_code=f"AWD{index:03}",
                first_name=first_name,
                last_name=last_name,
                nationality="CountryA",
                position="Guard",
                height_cm=190 + index,
            )
        )
    session.commit()


def _season_label(year: int) -> str:
    return f"{year}\u2013{str(year + 1)[-2:]}"


def _regular_mvp_page(*, missing_label: str | None = None) -> str:
    rows = []
    labels = [
        (2013, "Mvp One"),
        (2014, "Mvp Two"),
        (2015, "Mvp Three"),
        (2016, "Mvp Four"),
        (2017, "Mvp Five"),
        (2018, missing_label or "Mvp Six"),
        (2020, "Mvp Seven"),
    ]
    for year, label in labels[:6]:
        first, last = label.split(" ", 1)
        rows.append(
            f"""
|-
| [[{year} Euroleague|{_season_label(year)}]]
| {{{{Sortname|{first}|{last}}}}}
| {{{{center|[[Guard|G]]}}}}
| {{{{USA}}}}
| [[Alpha Club]]
|
"""
        )
    rows.append(
        """
|-
| [[2019\u201320 EuroLeague|2019\u201320]]
! scope="row" colspan=5|{{center|''Not awarded''}}
"""
    )
    year, label = labels[-1]
    rows.append(
        f"""
|-
| [[{year}\u201321 EuroLeague|{_season_label(year)}]]
| [[{label}]] (2)
| {{{{center|[[Guard|G]]}}}}
| {{{{USA}}}}
| [[Alpha Club]]
|
"""
    )
    return (
        '{| class="wikitable plainrowheaders"\n'
        "! Season !! Player !! Pos. !! Nationality !! Club !! Ref.\n"
        + "".join(rows)
        + "|}"
    )


def _final_four_mvp_page() -> str:
    rows = [
        """
|-
|{{center|[[2001 SuproLeague Final Four|2000\u201301]]\u2020 <br/> ([[FIBA SuproLeague|SuproLeague]]) }} || {{flagicon|USA}} [[Ariel McDonald]] || [[Maccabi Elite Tel Aviv]]
|
|-
|{{center|[[2001 EuroLeague Finals|2000\u201301]]\u2020 <br/> ([[EuroLeague]])}} || !scope="row" style="background-color:#FFFF99"| {{flagicon|ARG}} [[Manu Gin\u00f3bili]]* || [[Kinder Bologna]]
|
"""
    ]
    for offset, year in enumerate(range(2001, 2008), start=1):
        rows.append(
            f"""
|-
|{{{{center|[[{year + 1} EuroLeague Final Four|{_season_label(year)}]]}}}} || {{{{flagicon|USA}}}} [[F4 {offset}]] || [[Alpha Club]]
|
"""
        )
    rows.append(
        f"""
|-
|{{{{center|[[2009 EuroLeague Final Four|{_season_label(2008)}]]}}}}
|{{{{Flag icon|Greece}}}} [[F4 Eight]]
|{{{{Flag icon|Greece}}}} [[Alpha Club]]
|
|-
|{{{{center|[[2010 EuroLeague Final Four|{_season_label(2009)}]]}}}}
|{{{{Flag icon|France}}}} [[F4 Nine]] (2)
|{{{{Flag icon|Greece}}}} [[Alpha Club]]
|
"""
    )
    return (
        '{| class="wikitable sortable"\n'
        "! Season !! Final Four MVP !! Club !! Ref.\n"
        + "".join(rows)
        + "|}"
    )


def test_parse_regular_mvp_handles_sortname_and_not_awarded_rows():
    rows = parse_player_award_winners(REGULAR_SEASON_MVP, _regular_mvp_page())

    assert rows[0].source_player_label == "Mvp One"
    assert rows[0].source_player_url == "https://en.wikipedia.org/wiki/Mvp_One"
    assert rows[-2].season_year == 2019
    assert rows[-2].exclude_reason == "not_awarded"
    assert rows[-1].source_player_label == "Mvp Seven"


def test_parse_final_four_mvp_handles_suproleague_and_multiline_rows():
    rows = parse_player_award_winners(FINAL_FOUR_MVP, _final_four_mvp_page())

    assert rows[0].season_year == 2000
    assert rows[0].source_player_label == "Ariel McDonald"
    assert rows[0].exclude_reason == "suproleague_excluded"
    assert "suproleague" in rows[0].source_row_key
    assert rows[1].source_player_label == "Manu Gin\u00f3bili"
    assert rows[1].exclude_reason is None
    assert rows[-1].source_player_label == "F4 Nine"


def test_ingest_regular_mvp_activates_revision_with_not_awarded_report(
    session,
    tmp_path: Path,
):
    _seed_award_players(
        session,
        years=range(2013, 2021),
        labels=[
            "Mvp One",
            "Mvp Two",
            "Mvp Three",
            "Mvp Four",
            "Mvp Five",
            "Mvp Six",
            "Mvp Seven",
        ],
    )
    report_path = tmp_path / "player-awards-report.json"

    report = ingest_player_awards(
        session,
        FakePlayerAwardsAdapter({REGULAR_SEASON_MVP: _regular_mvp_page()}),
        PlayerAwardsIngestOptions(
            start_year=2013,
            end_year=2020,
            metrics=(REGULAR_SEASON_MVP,),
            overrides_path=None,
            report_path=report_path,
        ),
    )
    session.commit()

    award_report = report.awards[REGULAR_SEASON_MVP]
    revision = session.query(AwardDataRevision).one()
    assert award_report.threshold_passed is True
    assert award_report.accepted == 7
    assert award_report.excluded == 1
    assert award_report.coverage is not None
    assert award_report.coverage.eligible_windows[0]["unique_winners"] == 7
    assert revision.is_active is True
    assert revision.enabled_metric == REGULAR_SEASON_MVP
    assert report_path.exists()


def test_ingest_final_four_mvp_excludes_suproleague_and_accepts_euroleague_row(
    session,
):
    _seed_award_players(
        session,
        years=range(2000, 2010),
        labels=[
            "Manu Ginobili",
            "F4 1",
            "F4 2",
            "F4 3",
            "F4 4",
            "F4 5",
            "F4 6",
            "F4 7",
            "F4 Eight",
            "F4 Nine",
        ],
    )

    report = ingest_player_awards(
        session,
        FakePlayerAwardsAdapter({FINAL_FOUR_MVP: _final_four_mvp_page()}),
        PlayerAwardsIngestOptions(
            start_year=2000,
            end_year=2009,
            metrics=(FINAL_FOUR_MVP,),
            overrides_path=None,
        ),
    )
    session.commit()

    award_report = report.awards[FINAL_FOUR_MVP]
    excluded = (
        session.query(PlayerAwardSelection)
        .filter(PlayerAwardSelection.match_method == "suproleague_excluded")
        .one()
    )
    accepted_2000 = (
        session.query(PlayerAwardSelection)
        .filter(PlayerAwardSelection.season_year == 2000)
        .filter(PlayerAwardSelection.status == "accepted")
        .one()
    )
    assert award_report.threshold_passed is True
    assert award_report.accepted == 10
    assert excluded.source_player_label == "Ariel McDonald"
    assert accepted_2000.source_player_label == "Manu Gin\u00f3bili"


def test_ingest_player_awards_does_not_activate_with_unresolved_mapping(
    session,
):
    _seed_award_players(
        session,
        years=range(2013, 2021),
        labels=[
            "Mvp One",
            "Mvp Two",
            "Mvp Three",
            "Mvp Four",
            "Mvp Five",
            "Mvp Seven",
        ],
    )

    report = ingest_player_awards(
        session,
        FakePlayerAwardsAdapter(
            {REGULAR_SEASON_MVP: _regular_mvp_page(missing_label="Mvp Missing")}
        ),
        PlayerAwardsIngestOptions(
            start_year=2013,
            end_year=2020,
            metrics=(REGULAR_SEASON_MVP,),
            overrides_path=None,
        ),
    )
    session.commit()

    award_report = report.awards[REGULAR_SEASON_MVP]
    revision = session.query(AwardDataRevision).one()
    assert award_report.threshold_passed is False
    assert award_report.unmatched == 1
    assert award_report.coverage is not None
    assert award_report.coverage.unresolved_rows
    assert revision.is_active is False
    assert revision.enabled_metric is None
