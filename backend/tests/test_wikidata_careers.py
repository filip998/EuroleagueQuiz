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
    PlayerSeasonTeam,
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
    normalized_stint_season_years,
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


def test_override_file_can_correct_and_extend_player_stints(session, tmp_path):
    player = _add_player_with_stats(session, first_name="Mathias", last_name="Lessort")
    candidate = WikidataPlayerCandidate("Q17634891", "Mathias Lessort")
    override_path = tmp_path / "overrides.json"
    override_path.write_text(
        """{
          "players": [{
            "player_id": %d,
            "wikidata_qid": "Q17634891",
            "stint_updates": [{"team_qid": "Q912247", "end_year": 2023}],
            "extra_stints": [{"team_qid": "Q739287", "team_label": "Panathinaikos B.C.", "start_year": 2023}]
          }]
        }"""
        % player.id
    )
    adapter = FakeWikidataAdapter(
        candidates={"Q17634891": candidate},
        memberships={
            "Q17634891": [
                _club("Q819694", "Maccabi Tel Aviv B.C.", "+2021-00-00T00:00:00Z", "+2021-00-00T00:00:00Z"),
                _club("Q912247", "KK Partizan", "+2021-00-00T00:00:00Z", None),
            ]
        },
    )

    report = ingest_wikidata_careers(
        session,
        adapter,
        IngestOptions(min_eligible_players=1, overrides_path=override_path),
    )

    stints = (
        session.query(PlayerCareerStint)
        .filter_by(player_id=player.id, include_in_quiz=True)
        .order_by(PlayerCareerStint.sequence_index)
        .all()
    )
    assert report.eligible_players == 1
    assert [(stint.wikidata_team_label, stint.start_season, stint.end_season) for stint in stints] == [
        ("Maccabi Tel Aviv B.C.", "2021/22", "2021/22"),
        ("KK Partizan", "2021/22", "2022/23"),
        ("Panathinaikos B.C.", "2023/24", None),
    ]


def test_same_year_precision_stint_uses_start_season_for_single_year():
    membership = _club(
        "Q819694",
        "Maccabi Tel Aviv B.C.",
        "+2021-00-00T00:00:00Z",
        "+2021-00-00T00:00:00Z",
    )

    assert normalized_stint_season_years(membership) == (2021, 2021)


def test_local_euroleague_stints_extend_incomplete_wikidata_career(session):
    player = _add_player_with_stats(session, first_name="Mathias", last_name="Lessort")
    candidate = WikidataPlayerCandidate("Q17634891", "Mathias Lessort")
    _add_local_stint(session, player, "PARTIZAN BELGRADE", "PAR", 2022)
    _add_local_stint(session, player, "PANATHINAIKOS", "PAN", 2023)
    _add_local_stint(session, player, "PANATHINAIKOS", "PAN", 2024)
    adapter = FakeWikidataAdapter(
        searches={"Mathias Lessort": [candidate]},
        memberships={
            "Q17634891": [
                _club("Q819694", "Maccabi Tel Aviv B.C.", "+2021-00-00T00:00:00Z", "+2021-00-00T00:00:00Z"),
                _club("Q912247", "KK Partizan", "+2021-00-00T00:00:00Z", None),
            ]
        },
    )

    report = ingest_wikidata_careers(
        session,
        adapter,
        IngestOptions(min_eligible_players=1),
    )

    stints = (
        session.query(PlayerCareerStint)
        .filter_by(player_id=player.id, include_in_quiz=True)
        .order_by(PlayerCareerStint.sequence_index)
        .all()
    )
    assert report.eligible_players == 1
    assert [(stint.wikidata_team_label, stint.start_season, stint.end_season) for stint in stints] == [
        ("Maccabi Tel Aviv B.C.", "2021/22", "2021/22"),
        ("KK Partizan", "2021/22", "2022/23"),
        ("PANATHINAIKOS", "2023/24", None),
    ]


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


def _add_local_stint(session, player: Player, team_name: str, team_code: str, year: int) -> None:
    season = session.query(Season).filter_by(year=year).first()
    if season is None:
        season = Season(year=year, name=f"{year}-{year + 1}")
        session.add(season)
        session.flush()
    team = session.query(Team).filter_by(euroleague_code=team_code).first()
    if team is None:
        team = Team(euroleague_code=team_code, name=team_name)
        session.add(team)
        session.flush()
    session.add(PlayerSeasonTeam(player_id=player.id, team_id=team.id, season_id=season.id))
    session.commit()


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
