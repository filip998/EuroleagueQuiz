from datetime import date
import hashlib
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models import (
    CareerDataRevision,
    Game,
    GamePlayerStats,
    Player,
    PlayerCareerSourceMapping,
    PlayerCareerStint,
    PlayerSeasonTeam,
    Season,
    Team,
)
from ingestion.wikipedia_careers import (
    ACCEPTED,
    CareerTeamResolver,
    DEFAULT_CANDIDATE_LIMIT,
    IngestOptions,
    WikipediaPage,
    WikipediaPageCandidate,
    _select_candidate_players,
    ingest_wikipedia_careers,
    parse_career_rows,
    parse_year_range,
)


YAM_MADAR_WIKITEXT = """
{{Infobox basketball biography
| name = Yam Madar
| birth_date = {{birth date and age|2000|12|21}}
| career_start = 2018
| years1 = 2018–2021
| team1 = [[Hapoel Tel Aviv B.C.|Hapoel Tel Aviv]]
| years2 = 2021–2023
| team2 = [[Partizan Belgrade|Partizan]]
| years3 = 2023–2024
| team3 = [[Fenerbahçe Men's Basketball|Fenerbahçe]]
| years4 = 2024
| team4 = [[FC Bayern Munich (basketball)|Bayern Munich]]
| years5 = 2024–present
| team5 = [[Hapoel Tel Aviv B.C.|Hapoel Tel Aviv]]
}}
"""


SERGE_IBAKA_WIKITEXT = """
{{Infobox basketball biography
| name = Serge Ibaka
| birth_date = {{birth date and age|1989|9|18}}
| years1 = 2007–2008
| team1 = [[CB L'Hospitalet]]
| years2 = 2008–2009
| team2 = [[Bàsquet Manresa]]
| years3 = 2009–2016
| team3 = [[Oklahoma City Thunder]]
| years4 = 2011
| team4 = [[Real Madrid Baloncesto|Real Madrid]]
| years5 = 2016–2017
| team5 = [[Orlando Magic]]
| years6 = 2017–2020
| team6 = [[Toronto Raptors]]
| years7 = 2023–2024
| team7 = [[FC Bayern Munich (basketball)|Bayern Munich]]
| years8 = 2024–2025
| team8 = [[Real Madrid Baloncesto|Real Madrid]]
}}
"""


class FakeWikipediaAdapter:
    def __init__(self, *, searches=None, pages=None):
        self.searches = searches or {}
        self.pages = pages or {}

    def search_pages(self, name: str):
        return self.searches.get(name, [])

    def fetch_page(self, title: str):
        return self.pages.get(title)


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


def test_parse_career_rows_extracts_wikipedia_infobox_history():
    rows = parse_career_rows(YAM_MADAR_WIKITEXT)

    assert [(row.team_label, row.raw_start, row.raw_end, row.start_year, row.end_year, row.is_current) for row in rows] == [
        ("Hapoel Tel Aviv", "2018", "2021", 2018, 2020, False),
        ("Partizan", "2021", "2023", 2021, 2022, False),
        ("Fenerbahçe", "2023", "2024", 2023, 2023, False),
        ("Bayern Munich", "2024", "2024", 2024, 2024, False),
        ("Hapoel Tel Aviv", "2024", None, 2024, None, True),
    ]


def test_parse_year_range_maps_wikipedia_years_to_seasons():
    assert parse_year_range("2018–2021") == ("2018", "2021", 2018, 2020, False)
    assert parse_year_range("2024") == ("2024", "2024", 2024, 2024, False)
    assert parse_year_range("2024–present") == ("2024", None, 2024, None, True)
    assert parse_year_range("{{nbay|2009|start}}–{{nbay|2015|end}}") == (
        "2009",
        "2015",
        2009,
        2015,
        False,
    )


def test_default_ingest_limit_is_approved_candidate_count():
    assert IngestOptions().limit == 500
    assert DEFAULT_CANDIDATE_LIMIT == 500


def test_ingest_uses_wikipedia_career_rows_for_missing_non_euroleague_stints(session, tmp_path):
    player = _add_player_with_stats(
        session,
        first_name="Yam",
        last_name="Madar",
        birth_date=date(2000, 12, 21),
    )
    _add_local_stint(session, player, "PARTIZAN BELGRADE", "PAR", 2022)
    _add_local_stint(session, player, "FENERBAHCE ULKER", "ULK", 2023)
    _add_local_stint(session, player, "FC BAYERN MUNICH", "MUN", 2024)
    _add_local_stint(session, player, "HAPOEL IBI TEL AVIV", "HTA", 2025)
    overrides = _overrides_file(
        tmp_path,
        team_aliases={
            "Hapoel Tel Aviv": "HTA",
            "Hapoel Tel Aviv B.C.": "HTA",
            "Fenerbahçe": "ULK",
            "Fenerbahçe Men's Basketball": "ULK",
            "Bayern Munich": "MUN",
            "FC Bayern Munich (basketball)": "MUN",
            "Partizan": "PAR",
            "Partizan Belgrade": "PAR",
        },
    )
    adapter = FakeWikipediaAdapter(
        searches={"Yam Madar": [WikipediaPageCandidate(1, "Yam Madar")]},
        pages={"Yam Madar": _page(1, "Yam Madar", YAM_MADAR_WIKITEXT)},
    )

    report = ingest_wikipedia_careers(
        session,
        adapter,
        IngestOptions(min_eligible_players=1, overrides_path=overrides),
    )

    mapping = session.query(PlayerCareerSourceMapping).filter_by(player_id=player.id).one()
    stints = (
        session.query(PlayerCareerStint)
        .filter_by(player_id=player.id, include_in_quiz=True)
        .order_by(PlayerCareerStint.sequence_index)
        .all()
    )
    revision = session.query(CareerDataRevision).one()
    assert report.eligible_players == 1
    assert mapping.status == ACCEPTED
    assert mapping.source_player_label == "Yam Madar"
    assert revision.is_active is True
    assert [(stint.source_team_label, stint.start_season, stint.end_season) for stint in stints] == [
        ("Hapoel Tel Aviv", "2018/19", "2020/21"),
        ("Partizan", "2021/22", "2022/23"),
        ("Fenerbahçe", "2023/24", "2023/24"),
        ("Bayern Munich", "2024/25", "2024/25"),
        ("Hapoel Tel Aviv", "2024/25", None),
    ]


def test_ingest_keeps_repeated_team_returns_as_separate_stints(session, tmp_path):
    player = _add_player_with_stats(
        session,
        first_name="Serge",
        last_name="Ibaka",
        birth_date=date(1989, 9, 18),
    )
    _add_local_stint(session, player, "REAL MADRID", "MAD", 2011)
    _add_local_stint(session, player, "FC BAYERN MUNICH", "MUN", 2023)
    _add_local_stint(session, player, "REAL MADRID", "MAD", 2024)
    overrides = _overrides_file(
        tmp_path,
        team_aliases={
            "Real Madrid": "MAD",
            "Real Madrid Baloncesto": "MAD",
            "Bayern Munich": "MUN",
            "FC Bayern Munich (basketball)": "MUN",
        },
    )
    adapter = FakeWikipediaAdapter(
        searches={"Serge Ibaka": [WikipediaPageCandidate(2, "Serge Ibaka")]},
        pages={"Serge Ibaka": _page(2, "Serge Ibaka", SERGE_IBAKA_WIKITEXT)},
    )

    report = ingest_wikipedia_careers(
        session,
        adapter,
        IngestOptions(min_eligible_players=1, overrides_path=overrides),
    )

    stints = (
        session.query(PlayerCareerStint)
        .filter_by(player_id=player.id, include_in_quiz=True)
        .order_by(PlayerCareerStint.sequence_index)
        .all()
    )
    assert report.eligible_players == 1
    assert ("Real Madrid", "2011/12", "2011/12") in [
        (stint.source_team_label, stint.start_season, stint.end_season) for stint in stints
    ]
    assert ("Real Madrid", "2024/25", "2024/25") in [
        (stint.source_team_label, stint.start_season, stint.end_season) for stint in stints
    ]
    assert not any(
        stint.source_team_label == "Real Madrid"
        and stint.start_season == "2011/12"
        and stint.end_season == "2024/25"
        for stint in stints
    )


def test_birth_date_conflict_still_accepts_single_candidate(session):
    player = _add_player_with_stats(
        session,
        first_name="Yam",
        last_name="Madar",
        birth_date=date(1999, 12, 21),
    )
    adapter = FakeWikipediaAdapter(
        searches={"Yam Madar": [WikipediaPageCandidate(1, "Yam Madar")]},
        pages={"Yam Madar": _page(1, "Yam Madar", YAM_MADAR_WIKITEXT)},
    )

    report = ingest_wikipedia_careers(
        session,
        adapter,
        IngestOptions(min_eligible_players=1),
    )

    mapping = session.query(PlayerCareerSourceMapping).filter_by(player_id=player.id).one()
    assert report.birth_conflicts == 0
    assert mapping.status == ACCEPTED
    assert session.query(PlayerCareerStint).filter_by(player_id=player.id).count() == 5


def test_single_basketball_candidate_can_have_different_title(session):
    _add_player_with_stats(
        session,
        first_name="Walter",
        last_name="Tavares",
        birth_date=date(1992, 3, 22),
    )
    adapter = FakeWikipediaAdapter(
        searches={"Walter Tavares": [WikipediaPageCandidate(5, "Edy Tavares")]},
        pages={"Edy Tavares": WikipediaPage(
            page_id=5,
            title="Edy Tavares",
            url="https://en.wikipedia.org/wiki/Edy_Tavares",
            revision_id="rev-5",
            wikitext=YAM_MADAR_WIKITEXT,
            birth_date=date(1992, 3, 22),
            is_basketball_player=True,
        )},
    )

    report = ingest_wikipedia_careers(
        session,
        adapter,
        IngestOptions(min_eligible_players=1),
    )

    assert report.matched == 1
    mapping = session.query(PlayerCareerSourceMapping).one()
    assert mapping.source_player_label == "Edy Tavares"
    assert mapping.match_method == "first_basketball_candidate"


def test_unmatched_report_includes_reason_and_candidate_titles(session):
    _add_player_with_stats(
        session,
        first_name="Missing",
        last_name="Player",
        birth_date=date(1990, 1, 1),
    )
    adapter = FakeWikipediaAdapter(
        searches={
            "Missing Player": [
                WikipediaPageCandidate(10, "Missing Player (politician)"),
                WikipediaPageCandidate(11, "Different Basketball Player"),
            ]
        },
        pages={},
    )

    report = ingest_wikipedia_careers(
        session,
        adapter,
        IngestOptions(min_eligible_players=1),
    )

    player_report = report.players[0]
    assert player_report["status"] == "unmatched"
    assert player_report["reason"] == "No title-compatible basketball player page among search candidates"
    assert player_report["candidate_titles"] == [
        "Missing Player (politician)",
        "Different Basketball Player",
    ]


def test_candidate_selection_prioritizes_games_and_keeps_early_roster_players(session):
    games_leader = _add_player_with_stats(session, first_name="Games", last_name="Leader")
    games_second = _add_player_with_stats(session, first_name="Games", last_name="Second")
    early_player = _add_roster_only_player(
        session,
        first_name="Early",
        last_name="Legend",
        team_code="OLD",
        team_name="OLD TEAM",
        years=[2000, 2001, 2002, 2003],
    )
    _add_extra_game_stats(session, games_leader, count=4, year=2024)
    _add_extra_game_stats(session, games_second, count=1, year=2024)

    selections = _select_candidate_players(session, 3)

    assert [selection.name for _, selection in selections] == [
        "Games Leader",
        "Games Second",
        "Early Legend",
    ]
    assert selections[0][1].selection_source == "games_played"
    assert selections[2][1].selection_source == "early_roster"
    assert selections[2][0].id == early_player.id


def test_candidate_selection_uses_450_recent_and_50_early_for_500_limit(session):
    for index in range(455):
        player = _add_player_with_stats(session, first_name=f"Recent{index}", last_name="Player")
    for index in range(60):
        _add_roster_only_player(
            session,
            first_name=f"Early{index}",
            last_name="Player",
            team_code=f"E{index}",
            team_name=f"EARLY TEAM {index}",
            years=[2000, 2001, 2002, 2003],
        )

    selections = _select_candidate_players(session, 500)

    sources = [selection.selection_source for _, selection in selections]
    assert len(selections) == 500
    assert sources.count("games_played") == 450
    assert sources.count("early_roster") == 50


def test_team_resolver_does_not_match_unrelated_team_by_single_shared_token(session):
    team = Team(euroleague_code="EST", name="ADECCO ESTUDIANTES")
    session.add(team)
    session.flush()

    resolution = CareerTeamResolver(session).resolve("Estudiantes Concordia")

    assert resolution.team_key == "WIKI:estudiantes_concordia"
    assert resolution.local_team_id is None


def test_current_local_roster_extends_stale_wikipedia_stint(session, tmp_path):
    player = _add_player_with_stats(
        session,
        first_name="Stale",
        last_name="Current",
        birth_date=date(1990, 1, 1),
    )
    _add_local_stint(session, player, "REAL MADRID", "MAD", 2025)
    overrides = _overrides_file(
        tmp_path,
        team_aliases={
            "Real Madrid": "MAD",
            "Real Madrid Baloncesto": "MAD",
        },
    )
    wikitext = """
{{Infobox basketball biography
| name = Stale Current
| birth_date = {{birth date and age|1990|1|1}}
| years1 = 2024–2025
| team1 = [[Real Madrid Baloncesto|Real Madrid]]
| years2 = 2022–2024
| team2 = [[FC Barcelona Bàsquet|Barcelona]]
| years3 = 2020–2022
| team3 = [[Valencia Basket|Valencia]]
}}
"""
    adapter = FakeWikipediaAdapter(
        searches={"Stale Current": [WikipediaPageCandidate(3, "Stale Current")]},
        pages={"Stale Current": WikipediaPage(
            page_id=3,
            title="Stale Current",
            url="https://en.wikipedia.org/wiki/Stale_Current",
            revision_id="rev-3",
            wikitext=wikitext,
            birth_date=date(1990, 1, 1),
            is_basketball_player=True,
        )},
    )

    ingest_wikipedia_careers(
        session,
        adapter,
        IngestOptions(min_eligible_players=1, overrides_path=overrides),
    )

    real_madrid = (
        session.query(PlayerCareerStint)
        .filter_by(player_id=player.id, source_team_label="Real Madrid", include_in_quiz=True)
        .one()
    )
    assert real_madrid.start_season == "2024/25"
    assert real_madrid.end_season is None
    assert real_madrid.is_current is True


def test_only_final_present_row_stays_current(session):
    player = _add_player_with_stats(
        session,
        first_name="Two",
        last_name="Currents",
        birth_date=date(1991, 1, 1),
    )
    wikitext = """
{{Infobox basketball biography
| name = Two Currents
| birth_date = {{birth date and age|1991|1|1}}
| years1 = 2018–2020
| team1 = [[Valencia Basket|Valencia]]
| years2 = 2020–present
| team2 = [[Crvena zvezda]]
| years3 = 2024–present
| team3 = [[KK Spartak Subotica|Spartak Subotica]]
}}
"""
    adapter = FakeWikipediaAdapter(
        searches={"Two Currents": [WikipediaPageCandidate(4, "Two Currents")]},
        pages={"Two Currents": WikipediaPage(
            page_id=4,
            title="Two Currents",
            url="https://en.wikipedia.org/wiki/Two_Currents",
            revision_id="rev-4",
            wikitext=wikitext,
            birth_date=date(1991, 1, 1),
            is_basketball_player=True,
        )},
    )

    ingest_wikipedia_careers(
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
    assert sum(1 for stint in stints if stint.is_current) == 1
    assert [(stint.source_team_label, stint.start_season, stint.end_season, stint.is_current) for stint in stints] == [
        ("Valencia", "2018/19", "2019/20", False),
        ("Crvena zvezda", "2020/21", "2023/24", False),
        ("Spartak Subotica", "2024/25", None, True),
    ]


def _page(page_id: int, title: str, wikitext: str) -> WikipediaPage:
    return WikipediaPage(
        page_id=page_id,
        title=title,
        url=f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}",
        revision_id=f"rev-{page_id}",
        wikitext=wikitext,
        birth_date=date(2000, 12, 21) if title == "Yam Madar" else date(1989, 9, 18),
        is_basketball_player=True,
    )


def _overrides_file(tmp_path, *, team_aliases: dict[str, str]):
    path = tmp_path / "wikipedia_overrides.json"
    path.write_text(json.dumps({"team_aliases": team_aliases, "players": []}))
    return path


def _add_player_with_stats(
    session,
    *,
    first_name: str,
    last_name: str,
    birth_date: date | None = None,
):
    seed = player_code_seed(first_name, last_name)
    home = Team(euroleague_code=f"H{seed}", name=f"Home {seed}")
    away = Team(euroleague_code=f"A{seed}", name=f"Away {seed}")
    season = session.query(Season).filter_by(year=2024).first()
    if season is None:
        season = Season(year=2024, name="2024-25")
        session.add(season)
        session.flush()
    session.add_all([home, away])
    session.flush()
    game = Game(
        season_id=season.id,
        euroleague_gamecode=seed,
        home_team_id=home.id,
        away_team_id=away.id,
    )
    player = Player(
        euroleague_code=f"P{seed}",
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


def _add_roster_only_player(
    session,
    *,
    first_name: str,
    last_name: str,
    team_code: str,
    team_name: str,
    years: list[int],
) -> Player:
    player = Player(
        euroleague_code=f"P{player_code_seed(first_name, last_name)}",
        first_name=first_name,
        last_name=last_name,
    )
    team = Team(euroleague_code=team_code, name=team_name)
    session.add_all([player, team])
    session.flush()
    for year in years:
        season = session.query(Season).filter_by(year=year).first()
        if season is None:
            season = Season(year=year, name=f"{year}-{year + 1}")
            session.add(season)
            session.flush()
        session.add(PlayerSeasonTeam(player_id=player.id, team_id=team.id, season_id=season.id))
    session.commit()
    return player


def _add_extra_game_stats(session, player: Player, *, count: int, year: int) -> None:
    season = session.query(Season).filter_by(year=year).first()
    if season is None:
        season = Season(year=year, name=f"{year}-{year + 1}")
        session.add(season)
        session.flush()
    team = session.query(Team).first()
    assert team is not None
    for index in range(count):
        game = Game(
            season_id=season.id,
            euroleague_gamecode=player_code_seed(player.first_name or "", player.last_name or "") + index + 1000,
            home_team_id=team.id,
            away_team_id=team.id,
        )
        session.add(game)
        session.flush()
        session.add(GamePlayerStats(game_id=game.id, player_id=player.id, team_id=team.id))
    session.commit()


def player_code_seed(first_name: str, last_name: str) -> int:
    digest = hashlib.sha1(f"{first_name}|{last_name}".encode()).hexdigest()
    return int(digest[:10], 16)
