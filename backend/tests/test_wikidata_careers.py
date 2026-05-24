from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import (
    CareerDataRevision,
    Game,
    GamePlayerStats,
    Player,
    PlayerCareerStint,
    PlayerWikidataMapping,
    Season,
    Team,
)
from ingestion.wikidata_careers import (
    ACCEPTED,
    BIRTH_CONFLICT,
    REJECTED,
    IngestOptions,
    WikidataPlayerCandidate,
    WikidataTeamMembership,
    ingest_wikidata_careers,
)


class FakeWikidataAdapter:
    def __init__(self, *, searches=None, candidates=None, memberships=None):
        self.searches = searches or {}
        self.candidates = candidates or {}
        self.memberships = memberships or {}

    def search_basketball_players(self, name: str):
        return self.searches.get(name, [])

    def fetch_player_memberships(self, qid: str):
        return self.memberships.get(qid, [])

    def fetch_player_candidate(self, qid: str):
        return self.candidates.get(qid)


@pytest.fixture
def session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    try:
        yield db
    finally:
        db.close()
        Base.metadata.drop_all(engine)


def test_ingest_accepts_single_match_and_stores_eligible_timeline(session):
    player = _add_player_with_stats(
        session,
        first_name="Nikos",
        last_name="Zisis",
        birth_date=date(1983, 8, 16),
    )
    candidate = WikidataPlayerCandidate(
        qid="Q458576",
        label="Nikos Zisis",
        birth_date=date(1983, 8, 16),
    )
    adapter = FakeWikidataAdapter(
        searches={"Nikos Zisis": [candidate]},
        memberships={
            "Q458576": [
                _club("Q1", "AEK B.C.", "+2000-01-01T00:00:00Z", "+2005-01-01T00:00:00Z"),
                _team("QNT", "Greece men's national basketball team", is_professional_club=False, exclusion_reason="national_team"),
                _club("Q2", "Pallacanestro Treviso", "+2005-01-01T00:00:00Z", "+2007-01-01T00:00:00Z"),
                _club("Q3", "PBC CSKA Moscow", "+2007-01-01T00:00:00Z", None),
            ]
        },
    )

    report = ingest_wikidata_careers(
        session, adapter, IngestOptions(min_eligible_players=1)
    )

    mapping = session.query(PlayerWikidataMapping).filter_by(player_id=player.id).one()
    stints = (
        session.query(PlayerCareerStint)
        .filter_by(player_id=player.id, include_in_quiz=True)
        .order_by(PlayerCareerStint.sequence_index)
        .all()
    )
    revision = session.query(CareerDataRevision).one()

    assert report.threshold_passed is True
    assert report.eligible_players == 1
    assert mapping.status == ACCEPTED
    assert mapping.wikidata_qid == "Q458576"
    assert [stint.wikidata_team_label for stint in stints] == [
        "AEK B.C.",
        "Pallacanestro Treviso",
        "PBC CSKA Moscow",
    ]
    assert stints[0].start_season == "2000/01"
    assert stints[0].end_season == "2004/05"
    assert revision.is_active is True
    assert revision.revision == report.revision


def test_single_name_match_with_birth_conflict_requires_review(session):
    player = _add_player_with_stats(
        session,
        first_name="Same",
        last_name="Name",
        birth_date=date(1980, 1, 1),
    )
    candidate = WikidataPlayerCandidate(
        qid="QBAD",
        label="Same Name",
        birth_date=date(1981, 1, 1),
    )
    adapter = FakeWikidataAdapter(searches={"Same Name": [candidate]})

    report = ingest_wikidata_careers(
        session, adapter, IngestOptions(min_eligible_players=1)
    )

    mapping = session.query(PlayerWikidataMapping).filter_by(player_id=player.id).one()
    assert report.birth_conflicts == 1
    assert report.threshold_passed is False
    assert mapping.status == BIRTH_CONFLICT
    assert mapping.wikidata_qid is None


def test_multiple_candidates_use_birth_date_to_disambiguate(session):
    player = _add_player_with_stats(
        session,
        first_name="Common",
        last_name="Player",
        birth_date=date(1990, 5, 5),
    )
    wrong = WikidataPlayerCandidate("Q1", "Common Player", date(1988, 5, 5))
    correct = WikidataPlayerCandidate("Q2", "Common Player", date(1990, 5, 5))
    adapter = FakeWikidataAdapter(
        searches={"Common Player": [wrong, correct]},
        memberships={
            "Q2": [
                _club("T1", "Team One", "+2009-01-01T00:00:00Z", "+2011-01-01T00:00:00Z"),
                _club("T2", "Team Two", "+2011-01-01T00:00:00Z", "+2013-01-01T00:00:00Z"),
                _club("T3", "Team Three", "+2013-01-01T00:00:00Z", None),
            ]
        },
    )

    report = ingest_wikidata_careers(
        session, adapter, IngestOptions(min_eligible_players=1)
    )

    mapping = session.query(PlayerWikidataMapping).filter_by(player_id=player.id).one()
    assert report.eligible_players == 1
    assert mapping.status == ACCEPTED
    assert mapping.wikidata_qid == "Q2"
    assert mapping.match_method == "birth_date"


def test_override_file_can_reject_a_player(session, tmp_path):
    player = _add_player_with_stats(session, first_name="Manual", last_name="Reject")
    override_path = tmp_path / "overrides.json"
    override_path.write_text(
        '{"players": [{"player_id": %d, "status": "rejected", "note": "wrong person"}]}'
        % player.id
    )

    report = ingest_wikidata_careers(
        session,
        FakeWikidataAdapter(),
        IngestOptions(min_eligible_players=1, overrides_path=override_path),
    )

    mapping = session.query(PlayerWikidataMapping).filter_by(player_id=player.id).one()
    assert report.rejected == 1
    assert mapping.status == REJECTED
    assert mapping.reviewed is True
    assert mapping.review_note == "wrong person"


def _add_player_with_stats(
    session,
    *,
    first_name: str,
    last_name: str,
    birth_date: date | None = None,
):
    home = Team(euroleague_code=f"H{first_name[:3]}{last_name[:3]}", name="Home")
    away = Team(euroleague_code=f"A{first_name[:3]}{last_name[:3]}", name="Away")
    season = Season(year=2024, name="2024-25")
    session.add_all([home, away, season])
    session.flush()
    game = Game(
        season_id=season.id,
        euroleague_gamecode=player_code_seed(first_name, last_name),
        home_team_id=home.id,
        away_team_id=away.id,
    )
    player = Player(
        euroleague_code=f"P{player_code_seed(first_name, last_name)}",
        first_name=first_name,
        last_name=last_name,
        birth_date=birth_date,
    )
    session.add_all([game, player])
    session.flush()
    session.add(
        GamePlayerStats(
            game_id=game.id,
            player_id=player.id,
            team_id=home.id,
        )
    )
    session.commit()
    return player


def player_code_seed(first_name: str, last_name: str) -> int:
    return abs(hash((first_name, last_name))) % 1_000_000


def _club(team_qid: str, label: str, start: str, end: str | None):
    return _team(team_qid, label, start=start, end=end, is_professional_club=True)


def _team(
    team_qid: str,
    label: str,
    *,
    start: str | None = None,
    end: str | None = None,
    is_professional_club: bool,
    exclusion_reason: str | None = None,
):
    return WikidataTeamMembership(
        team_qid=team_qid,
        team_label=label,
        start=start,
        start_precision=9 if start else None,
        end=end,
        end_precision=9 if end else None,
        is_professional_club=is_professional_club,
        exclusion_reason=exclusion_reason,
    )
