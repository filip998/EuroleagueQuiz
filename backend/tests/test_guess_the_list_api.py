from pathlib import Path

import random
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models import (
    Game,
    GamePlayerStats,
    Player,
    PlayerSeasonTeam,
    PlayerSeasonStats,
    Season,
    Team,
)
from app.models.guess_the_list import GuessTheListGame, GuessTheListRound, GuessTheListSlot
from app.schemas.realtime import RealtimeServerMessageAdapter
from app.services import guess_the_list as guess_the_list_service
from app.services.realtime import DisconnectGraceTimerManager, OnlineGameRealtimeModule, TurnTimerManager
from app.services.realtime_adapters import GuessTheListRealtimeAdapter
from tests.realtime_helpers import FakeWebSocket, SleepController, drain_tasks


@pytest.fixture(autouse=True)
def _seed_random():
    random.seed(42)
    yield
    random.seed()


@pytest.fixture()
def client(tmp_path: Path):
    db_path = tmp_path / "guess_the_list_api_test.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        season = Season(year=2024, name="2024-2025")
        team = Team(euroleague_code="AAA", name="Alpha Club")
        session.add_all([season, team])
        session.flush()

        players = [
            Player(
                euroleague_code=f"P{i:03}",
                first_name=f"Player{i}",
                last_name="Roster",
                nationality="CountryA",
                position="Guard",
            )
            for i in range(1, 7)
        ]
        session.add_all(players)
        session.flush()

        for index, player in enumerate(players, start=1):
            session.add(
                PlayerSeasonTeam(
                    player_id=player.id,
                    team_id=team.id,
                    season_id=season.id,
                    jersey_number=str(index),
                )
            )
        session.commit()
    finally:
        session.close()

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    previous_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as test_client:
        test_client.session_local = TestingSessionLocal
        yield test_client

    if previous_override is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous_override
    engine.dispose()


def _action_payload(response) -> dict:
    payload = response.json()
    assert payload["type"] == "state"
    return payload["payload"]


def _create_guess_the_list_game(client: TestClient, mode: str = "single_player") -> dict:
    response = client.post(
        "/quiz/guess-the-list/games",
        json={
            "mode": mode,
            "target_wins": 2,
            "timer_mode": "40s",
            "player1_name": "Player One",
            "season_range_start": 2024,
            "season_range_end": 2024,
        },
    )
    assert response.status_code == 200
    return _action_payload(response)["game"]


def test_create_guess_the_list_game_returns_state_envelope(client: TestClient):
    game = _create_guess_the_list_game(client)

    assert game["mode"] == "single_player"
    assert game["category_type"] == "roster"
    assert game["round"]["status"] == "active"
    assert game["round"]["category_type"] == "roster"
    assert game["round"]["metric"] is None
    assert game["round"]["scope_label"] == "Alpha Club 2024"
    assert len(game["round"]["slots"]) >= 5
    assert [slot["jersey_number"] for slot in game["round"]["slots"]] == [
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
    ]
    assert all(
        slot["player_name"] is None
        and slot["rank"] is None
        and slot["stat_value"] is None
        and slot["stat_value_label"] is None
        for slot in game["round"]["slots"]
    )


class SyntheticSingleSeasonGenerator:
    def build_round(self, db, game, round_number):
        roster_rows = (
            db.query(PlayerSeasonTeam, Player)
            .join(Player, Player.id == PlayerSeasonTeam.player_id)
            .order_by(Player.id.asc())
            .all()
        )
        stat_rows = list(zip(roster_rows, [30, 25, 20, 15, 10, 10]))
        ranked_rows = guess_the_list_service.ranked_items_with_boundary_ties(
            stat_rows,
            limit=5,
            stat_value=lambda row: row[1],
        )
        slots = []
        for ranked_row in ranked_rows:
            (player_season_team, player), _ = ranked_row.item
            full_name = f"{player.first_name or ''} {player.last_name or ''}".strip()
            slots.append(
                guess_the_list_service.RoundSlotSpec(
                    player_season_team_id=player_season_team.id,
                    player_id=player.id,
                    jersey_number=player_season_team.jersey_number,
                    position=player.position,
                    nationality=player.nationality,
                    height_cm=player.height_cm,
                    player_name=full_name,
                    rank=ranked_row.rank,
                    stat_value=ranked_row.stat_value,
                    stat_value_label=f"{ranked_row.stat_value:g} PTS",
                )
            )

        return guess_the_list_service.RoundSpec(
            category_type=guess_the_list_service.CATEGORY_SINGLE_SEASON,
            metric="points",
            scope_label="Synthetic 2024 scoring leaders",
            team_id=None,
            season_id=None,
            team_code=None,
            team_name=None,
            season_year=2024,
            slots=tuple(slots),
        )


def test_ranked_items_with_boundary_ties_includes_cutoff_ties():
    ranked = guess_the_list_service.ranked_items_with_boundary_ties(
        [30, 25, 20, 15, 10, 10, 5],
        limit=5,
        stat_value=lambda value: value,
    )

    assert [item.stat_value for item in ranked] == [30, 25, 20, 15, 10, 10]
    assert [item.rank for item in ranked] == [1, 2, 3, 4, 5, 5]
    assert guess_the_list_service.ranked_items_with_boundary_ties(
        [30, 25],
        limit=0,
        stat_value=lambda value: value,
    ) == []


def test_synthetic_generator_dispatch_ties_and_answer_hiding(client: TestClient):
    with client.session_local() as db:
        now = datetime.utcnow()
        game = GuessTheListGame(
            mode="single_player",
            status="active",
            join_code=None,
            is_race=False,
            is_public=False,
            preset=None,
            category_type=guess_the_list_service.CATEGORY_SINGLE_SEASON,
            target_wins=2,
            turn_seconds=None,
            turn_started_at=None,
            race_round_seconds=None,
            race_reveal_seconds=None,
            player1_name="Player One",
            player2_name=None,
            player1_guest_id=None,
            player2_guest_id=None,
            player1_score=0,
            player2_score=0,
            current_player=1,
            round_number=0,
            winner_player=None,
            season_range_start=2024,
            season_range_end=2024,
            pending_end_from=None,
            pending_end_to=None,
            created_at=now,
            updated_at=now,
        )
        db.add(game)
        db.flush()

        round_obj = guess_the_list_service._create_next_round(
            db,
            game,
            registry={
                guess_the_list_service.CATEGORY_SINGLE_SEASON: (
                    SyntheticSingleSeasonGenerator()
                )
            },
        )
        db.flush()

        active_state = guess_the_list_service.serialize_game_state(db, game)
        active_round = active_state["round"]
        assert active_state["category_type"] == guess_the_list_service.CATEGORY_SINGLE_SEASON
        assert active_round["category_type"] == guess_the_list_service.CATEGORY_SINGLE_SEASON
        assert active_round["metric"] == "points"
        assert active_round["scope_label"] == "Synthetic 2024 scoring leaders"
        assert active_round["total_slots"] == 6
        assert all(
            slot["player_name"] is None
            and slot["rank"] is None
            and slot["stat_value"] is None
            and slot["stat_value_label"] is None
            and slot["jersey_number"] is None
            and slot["position"] is None
            and slot["nationality"] is None
            and slot["height_cm"] is None
            and "country_code" not in slot
            for slot in active_round["slots"]
        )

        storage_rank_order = [
            slot.rank
            for slot in db.query(GuessTheListSlot)
            .filter(GuessTheListSlot.round_id == round_obj.id)
            .order_by(GuessTheListSlot.id.asc())
            .all()
        ]
        assert storage_rank_order != [1, 2, 3, 4, 5, 5]

        claimed_slot = (
            db.query(GuessTheListSlot)
            .filter(GuessTheListSlot.round_id == round_obj.id)
            .filter(GuessTheListSlot.rank == 1)
            .one()
        )
        claimed_slot.guessed_by_player = 1
        claimed_slot.guessed_at = datetime.utcnow()
        db.flush()

        claimed_state = guess_the_list_service.serialize_game_state(db, game)
        claimed_payload = next(
            slot
            for slot in claimed_state["round"]["slots"]
            if slot["id"] == claimed_slot.id
        )
        assert claimed_payload["player_name"] == "Player1 Roster"
        assert claimed_payload["rank"] == 1
        assert claimed_payload["stat_value"] == 30.0
        assert claimed_payload["stat_value_label"] == "30 PTS"
        assert claimed_payload["jersey_number"] == "1"
        assert claimed_payload["position"] == "Guard"
        assert claimed_payload["nationality"] == "CountryA"
        assert all(
            slot["rank"] is None
            and slot["stat_value"] is None
            and slot["player_name"] is None
            and slot["jersey_number"] is None
            and slot["position"] is None
            and slot["nationality"] is None
            and slot["height_cm"] is None
            for slot in claimed_state["round"]["slots"]
            if slot["id"] != claimed_slot.id
        )

        round_obj.status = "completed"
        round_obj.completed_at = datetime.utcnow()
        db.flush()

        completed_round = guess_the_list_service.serialize_completed_round(
            db,
            game.id,
            round_obj.round_number,
        )
        assert completed_round is not None
        assert [slot["rank"] for slot in completed_round["slots"]] == [1, 2, 3, 4, 5, 5]
        assert [slot["stat_value"] for slot in completed_round["slots"]] == [
            30.0,
            25.0,
            20.0,
            15.0,
            10.0,
            10.0,
        ]
        assert all(slot["player_name"] for slot in completed_round["slots"])


@pytest.fixture()
def all_time_leaders_db():
    engine = create_engine("sqlite:///:memory:")
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        _seed_all_time_leaders_fixture(session)
        yield session
    finally:
        session.close()
        engine.dispose()


def _seed_all_time_leaders_fixture(session):
    home = Team(euroleague_code="ATL", name="All-Time Home")
    away = Team(euroleague_code="ATX", name="All-Time Away")
    session.add_all([home, away])
    session.flush()

    seasons = {
        year: Season(year=year, name=f"{year}-{year + 1}")
        for year in (2000, 2006, 2007, 2024, 2026)
    }
    session.add_all(seasons.values())
    session.flush()

    games = {}
    for year, season in seasons.items():
        games[year] = Game(
            season_id=season.id,
            euroleague_gamecode=year,
            round=1,
            phase="Regular Season",
            home_team_id=home.id,
            away_team_id=away.id,
        )
    session.add_all(games.values())
    session.flush()

    last_names = [
        "Alpha",
        "Bravo",
        "Charlie",
        "Delta",
        "Echo",
        "Foxtrot",
        "Golf",
        "Hotel",
        "India",
        "Juliet",
        "Kilo",
        "Lima",
        "Mike",
        "November",
    ]
    players = [
        Player(
            euroleague_code=f"ATL{i:03}",
            first_name=f"Leader{i:02}",
            last_name=last_name,
            nationality="CountryA",
            position="Guard",
            height_cm=180 + i,
        )
        for i, last_name in enumerate(last_names, start=1)
    ]
    session.add_all(players)
    session.flush()

    def add_stat(
        player_number,
        year,
        *,
        points=0,
        rebounds=0,
        assists=0,
        pir=0,
    ):
        session.add(
            GamePlayerStats(
                game_id=games[year].id,
                player_id=players[player_number - 1].id,
                team_id=home.id,
                points=points,
                total_rebounds=rebounds,
                assists=assists,
                pir=pir,
            )
        )

    add_stat(1, 2007, points=2000, rebounds=200, assists=300, pir=None)
    add_stat(1, 2024, points=3000, rebounds=300, assists=500, pir=5000)
    add_stat(2, 2024, points=4500, rebounds=550, assists=900, pir=4500)
    add_stat(3, 2024, points=4000, rebounds=600, assists=700, pir=6000)
    add_stat(4, 2024, points=3500, rebounds=650, assists=600, pir=4000)
    add_stat(5, 2024, points=3000, rebounds=700, assists=500, pir=3500)
    add_stat(6, 2024, points=2500, rebounds=450, assists=400, pir=3000)
    add_stat(7, 2024, points=2000, rebounds=400, assists=350, pir=2500)
    add_stat(8, 2024, points=1500, rebounds=350, assists=300, pir=2000)
    add_stat(9, 2024, points=1000, rebounds=300, assists=250, pir=1500)
    add_stat(10, 2000, points=900, rebounds=250, assists=200, pir=1000)
    add_stat(11, 2006, points=900, rebounds=250, assists=150, pir=900)
    add_stat(12, 2024, points=800, rebounds=200, assists=100, pir=800)
    add_stat(13, 2026, points=9999, rebounds=9999, assists=9999, pir=9999)
    add_stat(14, 2024, points=1, rebounds=1, assists=1, pir=None)
    session.commit()


def _new_all_time_game():
    now = datetime.utcnow()
    return GuessTheListGame(
        mode="single_player",
        status="active",
        join_code=None,
        is_race=False,
        is_public=False,
        preset=None,
        category_type=guess_the_list_service.CATEGORY_ALL_TIME,
        target_wins=2,
        turn_seconds=None,
        turn_started_at=None,
        race_round_seconds=None,
        race_reveal_seconds=None,
        player1_name="Player One",
        player2_name=None,
        player1_guest_id=None,
        player2_guest_id=None,
        player1_score=0,
        player2_score=0,
        current_player=1,
        round_number=0,
        winner_player=None,
        season_range_start=2000,
        season_range_end=2025,
        pending_end_from=None,
        pending_end_to=None,
        created_at=now,
        updated_at=now,
    )


def test_all_time_leaders_generator_points_totals_ordering_and_boundary_ties(
    all_time_leaders_db,
):
    spec = guess_the_list_service.AllTimeLeadersGenerator(metric="points").build_round(
        all_time_leaders_db,
        _new_all_time_game(),
        1,
    )

    assert spec.category_type == guess_the_list_service.CATEGORY_ALL_TIME
    assert spec.metric == "points"
    assert spec.scope_label == "All-time points leaders (2000-2025)"
    assert [
        (slot.player_name, slot.rank, slot.stat_value, slot.stat_value_label)
        for slot in spec.slots
    ] == [
        ("Leader01 Alpha", 1, 5000.0, "5,000 pts"),
        ("Leader02 Bravo", 2, 4500.0, "4,500 pts"),
        ("Leader03 Charlie", 3, 4000.0, "4,000 pts"),
        ("Leader04 Delta", 4, 3500.0, "3,500 pts"),
        ("Leader05 Echo", 5, 3000.0, "3,000 pts"),
        ("Leader06 Foxtrot", 6, 2500.0, "2,500 pts"),
        ("Leader07 Golf", 7, 2000.0, "2,000 pts"),
        ("Leader08 Hotel", 8, 1500.0, "1,500 pts"),
        ("Leader09 India", 9, 1000.0, "1,000 pts"),
        ("Leader10 Juliet", 10, 900.0, "900 pts"),
        ("Leader11 Kilo", 10, 900.0, "900 pts"),
    ]
    assert "Leader13 Mike" not in [slot.player_name for slot in spec.slots]


@pytest.mark.parametrize(
    ("metric", "expected_name", "expected_value", "expected_label"),
    [
        ("rebounds", "Leader05 Echo", 700.0, "700 reb"),
        ("assists", "Leader02 Bravo", 900.0, "900 ast"),
        ("pir", "Leader03 Charlie", 6000.0, "6,000 PIR"),
    ],
)
def test_all_time_leaders_generator_uses_metric_columns(
    all_time_leaders_db,
    metric,
    expected_name,
    expected_value,
    expected_label,
):
    spec = guess_the_list_service.AllTimeLeadersGenerator(metric=metric).build_round(
        all_time_leaders_db,
        _new_all_time_game(),
        1,
    )

    leader = spec.slots[0]
    assert spec.metric == metric
    assert leader.player_name == expected_name
    assert leader.stat_value == expected_value
    assert leader.stat_value_label == expected_label


def test_all_time_leaders_round_serialization_hides_then_reveals_ranked_slots(
    all_time_leaders_db,
):
    game = _new_all_time_game()
    all_time_leaders_db.add(game)
    all_time_leaders_db.flush()

    round_obj = guess_the_list_service._create_next_round(
        all_time_leaders_db,
        game,
        registry={
            guess_the_list_service.CATEGORY_ALL_TIME: (
                guess_the_list_service.AllTimeLeadersGenerator(metric="points")
            )
        },
    )
    all_time_leaders_db.flush()

    active_state = guess_the_list_service.serialize_game_state(
        all_time_leaders_db,
        game,
    )
    active_round = active_state["round"]
    assert active_state["category_type"] == guess_the_list_service.CATEGORY_ALL_TIME
    assert active_round["category_type"] == guess_the_list_service.CATEGORY_ALL_TIME
    assert active_round["metric"] == "points"
    assert active_round["total_slots"] == 11
    assert all(
        slot["player_name"] is None
        and slot["rank"] is None
        and slot["stat_value"] is None
        and slot["stat_value_label"] is None
        for slot in active_round["slots"]
    )

    round_obj.status = "completed"
    round_obj.completed_at = datetime.utcnow()
    all_time_leaders_db.flush()

    completed_round = guess_the_list_service.serialize_completed_round(
        all_time_leaders_db,
        game.id,
        round_obj.round_number,
    )
    assert completed_round is not None
    assert [slot["rank"] for slot in completed_round["slots"]] == [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        10,
    ]
    assert completed_round["slots"][0]["player_name"] == "Leader01 Alpha"
    assert completed_round["slots"][0]["stat_value"] == 5000.0
    assert completed_round["slots"][0]["stat_value_label"] == "5,000 pts"


def test_all_time_leaders_category_is_registered_for_game_creation(
    all_time_leaders_db,
    monkeypatch,
):
    monkeypatch.setattr(guess_the_list_service.random, "choice", lambda _metrics: "points")

    game = guess_the_list_service.create_game(
        all_time_leaders_db,
        mode="single_player",
        target_wins=2,
        timer_mode="40s",
        category_type=guess_the_list_service.CATEGORY_ALL_TIME,
        player1_name="Player One",
        season_range_start=2000,
        season_range_end=2025,
    )

    state = guess_the_list_service.serialize_game_state(all_time_leaders_db, game)
    assert state["category_type"] == guess_the_list_service.CATEGORY_ALL_TIME
    assert state["round"]["category_type"] == guess_the_list_service.CATEGORY_ALL_TIME
    assert state["round"]["metric"] == "points"
    assert state["round"]["scope_label"] == "All-time points leaders (2000-2025)"


@pytest.fixture()
def single_season_leaders_db():
    engine = create_engine("sqlite:///:memory:")
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        _seed_single_season_leaders_fixture(session)
        yield session
    finally:
        session.close()
        engine.dispose()


def _seed_single_season_leaders_fixture(session):
    home = Team(euroleague_code="SSL", name="Single Season Home")
    away = Team(euroleague_code="SSX", name="Single Season Away")
    session.add_all([home, away])
    session.flush()

    seasons = {
        year: Season(year=year, name=f"{year}-{year + 1}") for year in (2006, 2024)
    }
    session.add_all(seasons.values())
    session.flush()

    games = {2006: [], 2024: []}
    for year, season in seasons.items():
        for index in range(1, 5):
            game = Game(
                season_id=season.id,
                euroleague_gamecode=year * 100 + index,
                round=index,
                phase="Regular Season",
                home_team_id=home.id if index % 2 else away.id,
                away_team_id=away.id if index % 2 else home.id,
            )
            games[year].append(game)
    session.add_all([game for season_games in games.values() for game in season_games])
    session.flush()

    post_2007_rows = [
        ("Post01", "Alpha", 4, 80),
        ("Post02", "Bravo", 4, 76),
        ("Post03", "Charlie", 4, 72),
        ("Post04", "Delta", 4, 68),
        ("Post05", "Echo", 4, 64),
        ("Post06", "Foxtrot", 4, 60),
        ("Post07", "Golf", 4, 56),
        ("Post08", "Hotel", 4, 52),
        ("Post09", "India", 4, 48),
        ("Post10", "Juliet", 4, 44),
        ("Post11", "Kilo", 2, 22),
        ("Post12", "Lima", 4, 40),
        ("PostLow", "Fewgames", 1, 100),
    ]
    for index, (first_name, last_name, games_played, points) in enumerate(
        post_2007_rows,
        start=1,
    ):
        player = Player(
            euroleague_code=f"SSL24{index:03}",
            first_name=first_name,
            last_name=last_name,
            nationality="CountryA",
            position="Guard",
            height_cm=180 + index,
        )
        session.add(player)
        session.flush()
        stint = PlayerSeasonTeam(
            player_id=player.id,
            team_id=home.id,
            season_id=seasons[2024].id,
            jersey_number=str(index),
        )
        session.add(stint)
        session.flush()
        session.add(
            PlayerSeasonStats(
                player_season_team_id=stint.id,
                games_played=games_played,
                points=points,
                total_rebounds=0,
                assists=0,
                pir=0,
            )
        )

    pre_2007_rows = [
        ("Pre01", "Alpha", 4, 20),
        ("Pre02", "Bravo", 4, 19),
        ("Pre03", "Charlie", 4, 18),
        ("Pre04", "Delta", 4, 17),
        ("Pre05", "Echo", 4, 16),
        ("Pre06", "Foxtrot", 4, 15),
        ("Pre07", "Golf", 4, 14),
        ("Pre08", "Hotel", 4, 13),
        ("Pre09", "India", 4, 12),
        ("Pre10", "Juliet", 4, 11),
        ("Pre11", "Kilo", 2, 11),
        ("Pre12", "Lima", 4, 10),
        ("PreLow", "Fewgames", 1, 100),
    ]
    for index, (first_name, last_name, games_played, points_per_game) in enumerate(
        pre_2007_rows,
        start=1,
    ):
        player = Player(
            euroleague_code=f"SSL06{index:03}",
            first_name=first_name,
            last_name=last_name,
            nationality="CountryB",
            position="Forward",
            height_cm=190 + index,
        )
        session.add(player)
        session.flush()
        session.add(
            PlayerSeasonTeam(
                player_id=player.id,
                team_id=home.id,
                season_id=seasons[2006].id,
                jersey_number=str(index),
            )
        )
        for game in games[2006][:games_played]:
            session.add(
                GamePlayerStats(
                    game_id=game.id,
                    player_id=player.id,
                    team_id=home.id,
                    points=points_per_game,
                    total_rebounds=0,
                    assists=0,
                    pir=0,
                )
            )

    session.commit()


def _new_single_season_game(start_year=2024, end_year=2024):
    now = datetime.utcnow()
    return GuessTheListGame(
        mode="single_player",
        status="active",
        join_code=None,
        is_race=False,
        is_public=False,
        preset=None,
        category_type=guess_the_list_service.CATEGORY_SINGLE_SEASON,
        target_wins=2,
        turn_seconds=None,
        turn_started_at=None,
        race_round_seconds=None,
        race_reveal_seconds=None,
        player1_name="Player One",
        player2_name=None,
        player1_guest_id=None,
        player2_guest_id=None,
        player1_score=0,
        player2_score=0,
        current_player=1,
        round_number=0,
        winner_player=None,
        season_range_start=start_year,
        season_range_end=end_year,
        pending_end_from=None,
        pending_end_to=None,
        created_at=now,
        updated_at=now,
    )


def test_single_season_leaders_uses_player_season_stats_qualifier_and_ties(
    single_season_leaders_db,
):
    spec = guess_the_list_service.SingleSeasonLeadersGenerator(
        metric="points",
    ).build_round(
        single_season_leaders_db,
        _new_single_season_game(2024, 2024),
        1,
    )

    assert spec.category_type == guess_the_list_service.CATEGORY_SINGLE_SEASON
    assert spec.metric == "points"
    assert spec.season_year == 2024
    assert spec.scope_label == "2024 points per-game leaders"
    assert len(spec.slots) == 11
    assert [
        (slot.player_name, slot.rank, slot.stat_value, slot.stat_value_label)
        for slot in spec.slots
    ] == [
        ("Post01 Alpha", 1, 20.0, "20.0 ppg"),
        ("Post02 Bravo", 2, 19.0, "19.0 ppg"),
        ("Post03 Charlie", 3, 18.0, "18.0 ppg"),
        ("Post04 Delta", 4, 17.0, "17.0 ppg"),
        ("Post05 Echo", 5, 16.0, "16.0 ppg"),
        ("Post06 Foxtrot", 6, 15.0, "15.0 ppg"),
        ("Post07 Golf", 7, 14.0, "14.0 ppg"),
        ("Post08 Hotel", 8, 13.0, "13.0 ppg"),
        ("Post09 India", 9, 12.0, "12.0 ppg"),
        ("Post10 Juliet", 10, 11.0, "11.0 ppg"),
        ("Post11 Kilo", 10, 11.0, "11.0 ppg"),
    ]
    assert "PostLow Fewgames" not in [slot.player_name for slot in spec.slots]


def test_single_season_leaders_uses_boxscore_aggregates_for_pre_2007(
    single_season_leaders_db,
):
    spec = guess_the_list_service.SingleSeasonLeadersGenerator(
        metric="points",
    ).build_round(
        single_season_leaders_db,
        _new_single_season_game(2006, 2006),
        1,
    )

    assert spec.category_type == guess_the_list_service.CATEGORY_SINGLE_SEASON
    assert spec.metric == "points"
    assert spec.season_year == 2006
    assert len(spec.slots) == 11
    assert spec.slots[0].player_name == "Pre01 Alpha"
    assert spec.slots[0].stat_value_label == "20.0 ppg"
    assert [slot.rank for slot in spec.slots][-2:] == [10, 10]
    assert "Pre11 Kilo" in [slot.player_name for slot in spec.slots]
    assert "PreLow Fewgames" not in [slot.player_name for slot in spec.slots]


def test_single_season_leaders_category_is_registered_and_hides_active_answers(
    single_season_leaders_db,
):
    game = guess_the_list_service.create_game(
        single_season_leaders_db,
        mode="single_player",
        target_wins=2,
        timer_mode="40s",
        category_type=guess_the_list_service.CATEGORY_SINGLE_SEASON,
        player1_name="Player One",
        season_range_start=2024,
        season_range_end=2024,
    )

    state = guess_the_list_service.serialize_game_state(single_season_leaders_db, game)
    active_round = state["round"]
    assert state["category_type"] == guess_the_list_service.CATEGORY_SINGLE_SEASON
    assert active_round["category_type"] == guess_the_list_service.CATEGORY_SINGLE_SEASON
    assert active_round["metric"] == "points"
    assert active_round["total_slots"] == 11
    assert all(
        slot["player_name"] is None
        and slot["rank"] is None
        and slot["stat_value"] is None
        and slot["stat_value_label"] is None
        for slot in active_round["slots"]
    )

    round_obj = guess_the_list_service.get_active_round(single_season_leaders_db, game.id)
    round_obj.status = "completed"
    round_obj.completed_at = datetime.utcnow()
    single_season_leaders_db.flush()

    completed_round = guess_the_list_service.serialize_completed_round(
        single_season_leaders_db,
        game.id,
        round_obj.round_number,
    )
    assert completed_round is not None
    assert [slot["rank"] for slot in completed_round["slots"]][-2:] == [10, 10]
    assert completed_round["slots"][0]["player_name"] == "Post01 Alpha"
    assert completed_round["slots"][0]["stat_value_label"] == "20.0 ppg"


def test_legacy_roster_guess_http_routes_alias_guess_the_list(client: TestClient):
    create = client.post(
        "/quiz/roster-guess/games",
        json={
            "mode": "single_player",
            "target_wins": 2,
            "timer_mode": "40s",
            "player1_name": "Player One",
            "season_range_start": 2024,
            "season_range_end": 2024,
        },
    )
    assert create.status_code == 200
    game = _action_payload(create)["game"]

    legacy_get = client.get(f"/quiz/roster-guess/games/{game['id']}")
    assert legacy_get.status_code == 200
    assert legacy_get.json()["id"] == game["id"]

    autocomplete = client.get(
        "/quiz/roster-guess/players/autocomplete",
        params={"q": "Player", "limit": 3},
    )
    assert autocomplete.status_code == 200
    assert autocomplete.json()["count"] == 3

    pools = client.get("/quiz/roster-guess/quick-match/pools")
    assert pools.status_code == 200
    assert "modern-standard" in pools.json()["pools"]


def test_submit_guess_returns_state_envelope_with_result(client: TestClient):
    game = _create_guess_the_list_game(client)

    response = client.post(
        f"/quiz/guess-the-list/games/{game['id']}/guess",
        json={"player_id": 1},
    )

    assert response.status_code == 200
    payload = _action_payload(response)
    assert payload["result"] == "correct"
    assert any(
        slot["guessed_by_player"] == 1
        for slot in payload["game"]["round"]["slots"]
    )


def test_give_up_returns_completed_round_in_state_envelope(client: TestClient):
    game = _create_guess_the_list_game(client)

    response = client.post(f"/quiz/guess-the-list/games/{game['id']}/give-up")

    assert response.status_code == 200
    payload = _action_payload(response)
    assert payload["result"] == "given_up"
    assert payload["completed_round"]["status"] == "given_up"
    assert len(payload["completed_round"]["slots"]) >= 5


def test_online_guess_the_list_join_and_missing_player_error_envelope(client: TestClient):
    game = _create_guess_the_list_game(client, mode="online_friend")
    assert game["status"] == "waiting_for_opponent"
    assert game["join_code"] is not None

    join = client.post(
        "/quiz/guess-the-list/games/join",
        json={"join_code": game["join_code"], "player_name": "Joiner"},
    )
    assert join.status_code == 200
    joined = _action_payload(join)["game"]
    assert joined["id"] == game["id"]
    assert joined["status"] == "active"
    assert joined["round"] is not None

    # Anonymous play persists no guest identity.
    with client.session_local() as db:
        stored = db.get(GuessTheListGame, game["id"])
        assert stored.player1_guest_id is None
        assert stored.player2_guest_id is None

    guess = client.post(
        f"/quiz/guess-the-list/games/{joined['id']}/guess",
        json={"player_id": 1},
    )
    assert guess.status_code == 400
    assert guess.json() == {
        "type": "error",
        "payload": {
            "code": "invalid_input",
            "message": "Online game actions require player identity",
        },
    }


def test_online_guess_the_list_persists_guest_id(client: TestClient):
    create = client.post(
        "/quiz/guess-the-list/games",
        json={
            "mode": "online_friend",
            "target_wins": 2,
            "timer_mode": "40s",
            "player1_name": "Host",
            "season_range_start": 2024,
            "season_range_end": 2024,
            "guest_id": "host-guest-abc",
        },
    )
    assert create.status_code == 200
    game = _action_payload(create)["game"]
    assert "guest_id" not in game
    assert "player1_guest_id" not in game

    join = client.post(
        "/quiz/guess-the-list/games/join",
        json={
            "join_code": game["join_code"],
            "player_name": "Joiner",
            "guest_id": "joiner-guest-def",
        },
    )
    assert join.status_code == 200

    with client.session_local() as db:
        stored = db.get(GuessTheListGame, game["id"])
        assert stored.player1_guest_id == "host-guest-abc"
        assert stored.player2_guest_id == "joiner-guest-def"


def _create_guess_the_list_race(client: TestClient, target_wins: int = 2) -> dict:
    response = client.post(
        "/quiz/guess-the-list/race/games",
        json={
            "target_wins": target_wins,
            "player1_name": "Host",
            "season_range_start": 2024,
            "season_range_end": 2024,
            "guest_id": "host-race",
        },
    )
    assert response.status_code == 200
    return _action_payload(response)["game"]


def _join_guess_the_list_race(client: TestClient, join_code: str) -> dict:
    response = client.post(
        "/quiz/guess-the-list/race/games/join",
        json={
            "join_code": join_code,
            "player_name": "Joiner",
            "guest_id": "joiner-race",
        },
    )
    assert response.status_code == 200
    return _action_payload(response)["game"]


def test_guess_the_list_race_claims_slot_once_and_duplicate_has_no_penalty(client: TestClient):
    created = _create_guess_the_list_race(client)
    game = _join_guess_the_list_race(client, created["join_code"])
    slot_player_id = 1
    round_number = game["round_number"]

    claim = client.post(
        f"/quiz/guess-the-list/games/{game['id']}/guess?player=1",
        json={"player_id": slot_player_id, "round_number": round_number},
    )
    assert claim.status_code == 200
    claimed = _action_payload(claim)
    assert claimed["result"] == "correct"
    assert claimed["game"]["round"]["player1_correct"] == 1
    assert claimed["game"]["round"]["player2_correct"] == 0

    duplicate = client.post(
        f"/quiz/guess-the-list/games/{game['id']}/guess?player=2",
        json={"player_id": slot_player_id, "round_number": round_number},
    )
    assert duplicate.status_code == 200
    duplicated = _action_payload(duplicate)
    assert duplicated["result"] == "incorrect"
    assert duplicated["game"]["round"]["player1_correct"] == 1
    assert duplicated["game"]["round"]["player2_correct"] == 0


def test_guess_the_list_race_finishes_match_when_full_roster_claimed(client: TestClient):
    created = _create_guess_the_list_race(client, target_wins=1)
    game = _join_guess_the_list_race(client, created["join_code"])
    round_number = game["round_number"]
    player_ids = list(range(1, 7))

    result = None
    for player_id in player_ids:
        response = client.post(
            f"/quiz/guess-the-list/games/{game['id']}/guess?player=1",
            json={"player_id": player_id, "round_number": round_number},
        )
        assert response.status_code == 200
        result = _action_payload(response)

    assert result["result"] == "match_won"
    assert result["game"]["status"] == "finished"
    assert result["game"]["winner_player"] == 1
    assert result["completed_round"]["status"] == "completed"
    assert all(slot["player_name"] for slot in result["completed_round"]["slots"])


def test_guess_the_list_race_resign_finishes_match_for_opponent(client: TestClient):
    created = _create_guess_the_list_race(client, target_wins=2)
    game = _join_guess_the_list_race(client, created["join_code"])

    resign = client.post(
        f"/quiz/guess-the-list/games/{game['id']}/give-up?player=1",
    )
    assert resign.status_code == 200
    payload = _action_payload(resign)
    assert payload["result"] == "resigned"
    assert payload["terminal"] is True
    assert payload["game"]["status"] == "finished"
    assert payload["game"]["winner_player"] == 2

    with client.session_local() as db:
        stored = db.get(GuessTheListGame, game["id"])
        assert stored.status == "finished"
        assert stored.winner_player == 2


def test_guess_the_list_race_resign_requires_player_identity(client: TestClient):
    created = _create_guess_the_list_race(client, target_wins=2)
    game = _join_guess_the_list_race(client, created["join_code"])

    missing = client.post(f"/quiz/guess-the-list/games/{game['id']}/give-up")
    assert missing.status_code == 400
    assert missing.json()["type"] == "error"


def test_guess_the_list_race_double_resign_does_not_flip_winner(client: TestClient):
    created = _create_guess_the_list_race(client, target_wins=2)
    game = _join_guess_the_list_race(client, created["join_code"])

    first = client.post(f"/quiz/guess-the-list/games/{game['id']}/give-up?player=1")
    assert first.status_code == 200
    assert _action_payload(first)["game"]["winner_player"] == 2

    second = client.post(f"/quiz/guess-the-list/games/{game['id']}/give-up?player=2")
    assert second.status_code == 200
    payload = _action_payload(second)
    assert payload["game"]["status"] == "finished"
    assert payload["game"]["winner_player"] == 2
    assert "result" not in payload


def test_classic_single_player_give_up_still_returns_given_up(client: TestClient):
    game = _create_guess_the_list_game(client)

    response = client.post(f"/quiz/guess-the-list/games/{game['id']}/give-up")

    assert response.status_code == 200
    payload = _action_payload(response)
    assert payload["result"] == "given_up"
    assert payload["completed_round"]["status"] == "given_up"


def test_guess_the_list_race_timer_tie_starts_reveal_locked_next_round(client: TestClient):
    created = _create_guess_the_list_race(client, target_wins=2)
    game = _join_guess_the_list_race(client, created["join_code"])
    round_number = game["round_number"]
    player1_id = 1
    player2_id = 2

    assert client.post(
        f"/quiz/guess-the-list/games/{game['id']}/guess?player=1",
        json={"player_id": player1_id, "round_number": round_number},
    ).status_code == 200
    assert client.post(
        f"/quiz/guess-the-list/games/{game['id']}/guess?player=2",
        json={"player_id": player2_id, "round_number": round_number},
    ).status_code == 200

    with client.session_local() as db:
        stored = db.get(GuessTheListGame, game["id"])
        active_round = (
            db.query(GuessTheListRound)
            .filter_by(game_id=game["id"], round_number=round_number)
            .one()
        )
        active_round.created_at = datetime.utcnow() - timedelta(seconds=121)
        assert guess_the_list_service.handle_race_round_time_expired(
            db,
            stored,
            expected_round=round_number,
        )
        db.commit()

    state = client.get(f"/quiz/guess-the-list/games/{game['id']}").json()
    assert state["status"] == "active"
    assert state["player1_score"] == 0
    assert state["player2_score"] == 0
    assert state["round_number"] == round_number + 1
    assert state["latest_completed_round"]["winner_player"] is None
    assert state["latest_completed_round"]["next_round_starts_at"] is not None

    stale = client.post(
        f"/quiz/guess-the-list/games/{game['id']}/guess?player=1",
        json={
            "player_id": 1,
            "round_number": round_number,
        },
    )
    assert stale.status_code == 409
    assert stale.json()["payload"]["message"] == "round_stale"

    locked = client.post(
        f"/quiz/guess-the-list/games/{game['id']}/guess?player=1",
        json={
            "player_id": 1,
            "round_number": state["round_number"],
        },
    )
    assert locked.status_code == 409
    assert locked.json()["payload"]["message"] == "round_locked"


def test_guess_the_list_race_claim_after_deadline_resolves_without_late_award(client: TestClient):
    created = _create_guess_the_list_race(client, target_wins=2)
    game = _join_guess_the_list_race(client, created["join_code"])
    round_number = game["round_number"]

    first_claim = client.post(
        f"/quiz/guess-the-list/games/{game['id']}/guess?player=1",
        json={"player_id": 1, "round_number": round_number},
    )
    assert first_claim.status_code == 200

    with client.session_local() as db:
        active_round = (
            db.query(GuessTheListRound)
            .filter_by(game_id=game["id"], round_number=round_number)
            .one()
        )
        active_round.created_at = datetime.utcnow() - timedelta(seconds=121)
        db.commit()

    late_claim = client.post(
        f"/quiz/guess-the-list/games/{game['id']}/guess?player=2",
        json={"player_id": 2, "round_number": round_number},
    )
    assert late_claim.status_code == 200
    resolved = _action_payload(late_claim)
    assert resolved["result"] == "round_won"
    assert resolved["game"]["player1_score"] == 1
    assert resolved["game"]["player2_score"] == 0
    assert resolved["game"]["round_number"] == round_number + 1
    assert resolved["completed_round"]["player1_correct"] == 1
    assert resolved["completed_round"]["player2_correct"] == 0
    assert resolved["completed_round"]["guessed_count"] == 1


@pytest.mark.asyncio
async def test_guess_the_list_race_unattended_timeout_finishes_without_rearming(client: TestClient):
    created = _create_guess_the_list_race(client, target_wins=2)
    game = _join_guess_the_list_race(client, created["join_code"])
    round_number = game["round_number"]

    with client.session_local() as db:
        stored = db.get(GuessTheListGame, game["id"])
        active_round = (
            db.query(GuessTheListRound)
            .filter_by(game_id=game["id"], round_number=round_number)
            .one()
        )
        active_round.created_at = datetime.utcnow() - timedelta(seconds=121)
        db.commit()
        state = guess_the_list_service.serialize_game_state(db, stored)

    sleep = SleepController()
    module = OnlineGameRealtimeModule(
        GuessTheListRealtimeAdapter(),
        session_factory=client.session_local,
    )
    module.timer = TurnTimerManager(module._expire_turn, sleep=sleep)

    module.start_timer_from_state(state)
    await sleep.wait_for_call()
    sleep.release(0)
    await drain_tasks()

    assert len(sleep.calls) == 1
    assert not module.timer.has_timer(game["id"])

    with client.session_local() as db:
        stored = db.get(GuessTheListGame, game["id"])
        assert stored.status == "finished"
        assert stored.winner_player is None
        assert stored.round_number == round_number
        assert stored.player1_score == 0
        assert stored.player2_score == 0
        assert [round_obj.status for round_obj in stored.rounds] == ["completed"]


def test_guess_the_list_race_quick_match_pair_cancel_and_public_join_guard(client: TestClient):
    first = client.post(
        "/quiz/guess-the-list/quick-match",
        json={
            "preset": "modern-standard",
            "player_name": "One",
            "guest_id": "guest-one",
        },
    )
    assert first.status_code == 200
    waiting = _action_payload(first)["game"]
    assert waiting["status"] == "waiting_for_opponent"
    assert waiting["is_race"] is True
    assert waiting["is_public"] is True
    assert waiting["join_code"] is None

    with client.session_local() as db:
        stored = db.get(GuessTheListGame, waiting["id"])
        public_join_code = stored.join_code

    bypass = client.post(
        "/quiz/guess-the-list/race/games/join",
        json={
            "join_code": public_join_code,
            "player_name": "Bypass",
            "guest_id": "guest-bypass",
        },
    )
    assert bypass.status_code == 409

    repeat = client.post(
        "/quiz/guess-the-list/quick-match",
        json={
            "preset": "modern-standard",
            "player_name": "One again",
            "guest_id": "guest-one",
        },
    )
    assert repeat.status_code == 200
    assert _action_payload(repeat)["game"]["id"] == waiting["id"]
    assert _action_payload(repeat)["game"]["status"] == "waiting_for_opponent"

    pools = client.get("/quiz/guess-the-list/quick-match/pools")
    assert pools.status_code == 200
    assert pools.json()["pools"]["modern-standard"]["searching"] == 1

    second = client.post(
        "/quiz/guess-the-list/quick-match",
        json={
            "preset": "modern-standard",
            "player_name": "Two",
            "guest_id": "guest-two",
        },
    )
    assert second.status_code == 200
    matched = _action_payload(second)["game"]
    assert matched["id"] == waiting["id"]
    assert matched["status"] == "active"
    assert matched["round"] is not None
    assert matched["join_code"] is None

    cancel_seed = client.post(
        "/quiz/guess-the-list/quick-match",
        json={
            "preset": "full-quick",
            "player_name": "Cancel",
            "guest_id": "guest-cancel",
        },
    )
    search = _action_payload(cancel_seed)["game"]
    cancel = client.post(
        "/quiz/guess-the-list/quick-match/cancel",
        json={
            "preset": "full-quick",
            "game_id": search["id"],
            "guest_id": "guest-cancel",
        },
    )
    assert cancel.status_code == 200
    assert _action_payload(cancel)["game"]["status"] == "cancelled"


def test_guess_the_list_race_quick_match_rejects_invalid_preset(client: TestClient):
    response = client.post(
        "/quiz/guess-the-list/quick-match",
        json={
            "preset": "unknown",
            "player_name": "One",
            "guest_id": "guest-one",
        },
    )
    assert response.status_code == 400
    assert response.json()["payload"]["code"] == "invalid_input"


@pytest.mark.asyncio
async def test_guess_the_list_race_disconnect_grace_forfeits_active_game(client: TestClient):
    """Disconnecting player 1 from an active Race game forfeits the match."""
    created = _create_guess_the_list_race(client, target_wins=2)
    game_state = _join_guess_the_list_race(client, created["join_code"])
    game_id = game_state["id"]

    grace_sleep = SleepController()
    module = OnlineGameRealtimeModule(
        GuessTheListRealtimeAdapter(),
        session_factory=client.session_local,
        disconnect_grace_seconds=3,
    )
    module.disconnect_grace_timer = DisconnectGraceTimerManager(
        module._expire_disconnect_grace,
        sleep=grace_sleep,
    )
    leaving = FakeWebSocket()
    opponent = FakeWebSocket()
    await module.connections.connect(game_id, 1, leaving)
    await module.connections.connect(game_id, 2, opponent)

    module.disconnect(game_id, 1, leaving)
    await grace_sleep.wait_for_call()
    grace_sleep.release()
    await drain_tasks(5)

    with client.session_local() as db:
        stored = db.get(GuessTheListGame, game_id)
        assert stored.status == "finished"
        assert stored.winner_player == 2

    assert not module.disconnect_grace_timer.has_game_timer(game_id)
    message = opponent.sent[-1]
    RealtimeServerMessageAdapter.validate_python(message)
    assert message["payload"]["result"] == "opponent_left"
    assert message["payload"]["terminal"] is True
    assert message["payload"]["game"]["winner_player"] == 2


@pytest.mark.asyncio
async def test_guess_the_list_classic_online_disconnect_does_not_forfeit(client: TestClient):
    """Classic (non-Race) online Guess the List games do NOT trigger disconnect forfeits."""
    create_resp = client.post(
        "/quiz/guess-the-list/games",
        json={
            "mode": "online_friend",
            "target_wins": 3,
            "timer_mode": "40s",
            "player1_name": "Host",
            "guest_id": "host-classic",
            "season_range_start": 2024,
            "season_range_end": 2024,
        },
    )
    assert create_resp.status_code == 200
    join_code = _action_payload(create_resp)["game"]["join_code"]

    join_resp = client.post(
        "/quiz/guess-the-list/games/join",
        json={"join_code": join_code, "player_name": "Joiner", "guest_id": "joiner-classic"},
    )
    assert join_resp.status_code == 200
    game_id = _action_payload(join_resp)["game"]["id"]

    grace_sleep = SleepController()
    module = OnlineGameRealtimeModule(
        GuessTheListRealtimeAdapter(),
        session_factory=client.session_local,
        disconnect_grace_seconds=3,
    )
    module.disconnect_grace_timer = DisconnectGraceTimerManager(
        module._expire_disconnect_grace,
        sleep=grace_sleep,
    )
    leaving = FakeWebSocket()
    await module.connections.connect(game_id, 1, leaving)

    module.disconnect(game_id, 1, leaving)
    # Grace timer should NOT start for non-Race games.
    await drain_tasks(3)
    assert not module.disconnect_grace_timer.has_game_timer(game_id)

    with client.session_local() as db:
        stored = db.get(GuessTheListGame, game_id)
        assert stored.status == "active"
        assert stored.winner_player is None
