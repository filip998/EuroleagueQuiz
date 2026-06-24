from pathlib import Path

import asyncio
import logging
import pytest
import random
from datetime import date
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import main as app_main
from app.database import Base, get_db, get_session_factory
from app.main import app
from app.models import (
    Player,
    PlayerSeasonStats,
    PlayerSeasonTeam,
    QuizTicTacToeStatMilestonePlayer,
    Season,
    Team,
)
from app.models.tictactoe import QuizTicTacToeGame
from app.routers import quiz as quiz_router
from app.services import realtime as realtime_service
from app.schemas.realtime import RealtimeServerMessageAdapter
from app.schemas.realtime import RealtimeClientAction
from app.services import matchmaking, tictactoe as ttt_service
from app.services.realtime import DisconnectGraceTimerManager, OnlineGameRealtimeModule
from app.services.realtime_adapters import TicTacToeRealtimeAdapter
from app.services.tictactoe_stat_milestones import SHIPPED_STAT_MILESTONE_DEFINITIONS
from tests.realtime_helpers import FakeWebSocket, SleepController, drain_tasks


@pytest.fixture(autouse=True)
def _reset_board_cache():
    ttt_service.reset_board_cache()
    yield
    ttt_service.reset_board_cache()


@pytest.fixture(autouse=True)
def _seed_random():
    """Fix random seed so board generation is deterministic in tests."""
    random.seed(42)
    yield
    random.seed()


def _find_cell(game_state: dict, row_index: int, col_index: int) -> dict:
    for cell in game_state["round"]["cells"]:
        if cell["row_index"] == row_index and cell["col_index"] == col_index:
            return cell
    raise AssertionError(f"Cell not found at ({row_index}, {col_index})")


def _all_player_ids(client: TestClient) -> list[int]:
    response = client.get("/players/?limit=100")
    assert response.status_code == 200
    return [item["id"] for item in response.json()]


def _valid_player_ids_for_cell(client: TestClient, cell: dict) -> list[int]:
    """Return player IDs that autocomplete suggests for this cell."""
    params: dict = {"q": "", "limit": 50}
    if cell.get("row_team_code"):
        params["team_code_1"] = cell["row_team_code"]
    if cell.get("col_team_code"):
        if "team_code_1" in params:
            params["team_code_2"] = cell["col_team_code"]
        else:
            params["team_code_1"] = cell["col_team_code"]
    response = client.get("/quiz/tictactoe/players/autocomplete", params=params)
    assert response.status_code == 200
    return [item["player_id"] for item in response.json()["players"]]


def _valid_player_for_cell(client: TestClient, cell: dict) -> int:
    """Return the first player from autocomplete that's on ALL teams in this cell.

    Players 1-5 are on all teams, so they always work. Player 6 is only on
    team_a so is excluded by the intersection when any other team is involved.
    """
    all_ids = _all_player_ids(client)
    team_filtered = set(all_ids)
    for tc in [cell.get("row_team_code"), cell.get("col_team_code")]:
        if tc:
            resp = client.get("/quiz/tictactoe/players/autocomplete",
                              params={"q": "", "limit": 50, "team_code_1": tc})
            team_filtered &= {p["player_id"] for p in resp.json()["players"]}
    # When no team codes available (e.g. season×nationality), exclude player 6
    # by picking the lowest ID (players 1-5 are universally valid).
    assert team_filtered, "Expected at least one valid player for cell"
    return min(team_filtered)


def _invalid_player_for_cell(client: TestClient, cell: dict) -> int | None:
    """Return a player invalid for this cell, or None if all known players are valid."""
    valid_ids = set(_valid_player_ids_for_cell(client, cell))
    for player_id in _all_player_ids(client):
        if player_id not in valid_ids:
            return player_id
    return None


def _action_payload(response) -> dict:
    payload = response.json()
    assert payload["type"] == "state"
    return payload["payload"]


def _live_player_set_for_cell(db, player_ids: list[int], row_axis: dict, col_axis: dict) -> set[int]:
    return {
        player_id
        for player_id in player_ids
        if ttt_service._player_matches_cell(db, player_id, row_axis, col_axis)
    }


@pytest.fixture()
def client(tmp_path: Path):
    db_path = tmp_path / "ttt_api_test.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        season = Season(year=2024, name="2024-2025")
        # 6 teams so rows and columns can be fully disjoint
        team_a = Team(euroleague_code="AAA", name="Alpha Club")
        team_b = Team(euroleague_code="BBB", name="Beta Club")
        team_c = Team(euroleague_code="CCC", name="Gamma Club")
        team_d = Team(euroleague_code="DDD", name="Delta Club")
        team_e = Team(euroleague_code="EEE", name="Echo Club")
        team_f = Team(euroleague_code="FFF", name="Foxtrot Club")
        session.add_all([season, team_a, team_b, team_c, team_d, team_e, team_f])
        session.flush()

        player_1 = Player(euroleague_code="P001", first_name="Alex", last_name="Bridge", nationality="CountryA")
        player_2 = Player(euroleague_code="P002", first_name="Boris", last_name="Cross", nationality="CountryA")
        player_3 = Player(euroleague_code="P003", first_name="Carlos", last_name="Delta", nationality="CountryA")
        player_4 = Player(euroleague_code="P004", first_name="Dino", last_name="Edge", nationality="CountryA")
        player_5 = Player(euroleague_code="P005", first_name="Emil", last_name="Frost", nationality="CountryA")
        # Player 6 only plays for one team — guaranteed invalid for cross-team cells
        player_6 = Player(euroleague_code="P006", first_name="Frank", last_name="Gate", nationality="CountryA")
        session.add_all([player_1, player_2, player_3, player_4, player_5, player_6])
        session.flush()

        # Players 1-5 played for all 6 clubs in the main season
        links = []
        for p in [player_1, player_2, player_3, player_4, player_5]:
            for t in [team_a, team_b, team_c, team_d, team_e, team_f]:
                links.append((p.id, t.id, season.id))
        # Player 6 only for team_a in the main season (invalid for any non-team_a cell)
        links.append((player_6.id, team_a.id, season.id))
        for player_id, team_id, sid in links:
            session.add(
                PlayerSeasonTeam(
                    player_id=player_id,
                    team_id=team_id,
                    season_id=sid,
                    is_champion=player_id == player_1.id and team_id == team_a.id,
                )
            )
        for definition in SHIPPED_STAT_MILESTONE_DEFINITIONS:
            for player in [player_1, player_2, player_3, player_4, player_5]:
                session.add(
                    QuizTicTacToeStatMilestonePlayer(
                        milestone_key=definition.key,
                        player_id=player.id,
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
    previous_session_factory_override = app.dependency_overrides.get(get_session_factory)
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_session_factory] = lambda: TestingSessionLocal

    with TestClient(app) as test_client:
        test_client.session_local = TestingSessionLocal
        yield test_client

    if previous_override is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous_override
    if previous_session_factory_override is None:
        app.dependency_overrides.pop(get_session_factory, None)
    else:
        app.dependency_overrides[get_session_factory] = previous_session_factory_override
    engine.dispose()


@pytest.fixture()
def ttt_axis_session(tmp_path: Path):
    db_path = tmp_path / "ttt_axis_test.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()

    current_season = Season(year=2024, name="2024-2025")
    past_season = Season(year=2023, name="2023-2024")
    teams = [
        Team(euroleague_code=f"AX{index}", name=f"Axis Team {index}")
        for index in range(1, 7)
    ]
    session.add_all([current_season, past_season, *teams])
    session.flush()

    players = {
        "star": Player(
            euroleague_code="AXP001",
            first_name="Star",
            last_name="Guard",
            nationality="CountryA",
            position="Guard",
        ),
        "guard": Player(
            euroleague_code="AXP002",
            first_name="Current",
            last_name="Guard",
            nationality="CountryA",
            position="Guard",
        ),
        "forward": Player(
            euroleague_code="AXP003",
            first_name="Current",
            last_name="Forward",
            nationality="CountryB",
            position="Forward",
        ),
        "center": Player(
            euroleague_code="AXP004",
            first_name="Current",
            last_name="Center",
            nationality="CountryA",
            position="Center",
        ),
        "blank_position": Player(
            euroleague_code="AXP005",
            first_name="Blank",
            last_name="Position",
            nationality="CountryA",
            position="",
        ),
        "null_position": Player(
            euroleague_code="AXP006",
            first_name="Null",
            last_name="Position",
            nationality="CountryC",
            position=None,
        ),
        "team_past_only": Player(
            euroleague_code="AXP007",
            first_name="Past",
            last_name="Team",
            nationality="CountryA",
            position="Forward",
        ),
        "nationality_past_only": Player(
            euroleague_code="AXP008",
            first_name="Past",
            last_name="Nationality",
            nationality="CountryA",
            position="Center",
        ),
        "past_teammate": Player(
            euroleague_code="AXP009",
            first_name="Past",
            last_name="Teammate",
            nationality="CountryB",
            position="Guard",
        ),
        "non_overlap": Player(
            euroleague_code="AXP010",
            first_name="Non",
            last_name="Overlap",
            nationality="CountryB",
            position="Forward",
        ),
        "champion_non_teammate": Player(
            euroleague_code="AXP011",
            first_name="Champion",
            last_name="Nonteammate",
            nationality="CountryB",
            position="Guard",
        ),
        "season_team_mismatch": Player(
            euroleague_code="AXP012",
            first_name="Season",
            last_name="TeamMismatch",
            nationality="CountryB",
            position="Forward",
        ),
        "season_teammate_mismatch": Player(
            euroleague_code="AXP013",
            first_name="Season",
            last_name="TeammateMismatch",
            nationality="CountryB",
            position="Center",
        ),
    }
    session.add_all(players.values())
    session.flush()

    def add_stint(
        player_key: str,
        team: Team,
        season: Season,
        *,
        start: date | None = None,
        end: date | None = None,
        pir: int | None = None,
        is_champion: bool = False,
    ) -> PlayerSeasonTeam:
        stint = PlayerSeasonTeam(
            player_id=players[player_key].id,
            team_id=team.id,
            season_id=season.id,
            registration_start=start,
            registration_end=end,
            is_champion=is_champion,
        )
        session.add(stint)
        session.flush()
        if pir is not None:
            session.add(PlayerSeasonStats(player_season_team_id=stint.id, pir=pir))
        return stint

    team_a, team_b, team_c, team_d, team_e, team_f = teams
    universal_player_keys = [
        "star",
        "guard",
        "forward",
        "center",
        "blank_position",
        "null_position",
    ]
    for player_key in universal_player_keys:
        for team in teams:
            kwargs = {}
            if player_key == "star" and team == team_a:
                kwargs = {
                    "start": date(2024, 1, 1),
                    "end": date(2024, 6, 1),
                    "pir": 500,
                }
            elif player_key == "guard" and team == team_a:
                kwargs = {"start": date(2024, 2, 1), "end": date(2024, 5, 1)}
            add_stint(player_key, team, current_season, **kwargs)

    add_stint("team_past_only", team_a, past_season)
    add_stint("nationality_past_only", team_b, past_season)
    add_stint(
        "star",
        team_c,
        past_season,
        start=date(2023, 1, 1),
        end=date(2023, 6, 1),
        is_champion=True,
    )
    add_stint(
        "past_teammate",
        team_c,
        past_season,
        start=date(2023, 2, 1),
        end=date(2023, 5, 1),
    )
    add_stint(
        "non_overlap",
        team_a,
        current_season,
        start=date(2024, 7, 1),
        end=date(2024, 8, 1),
    )
    add_stint(
        "champion_non_teammate",
        team_c,
        past_season,
        start=date(2023, 7, 1),
        end=date(2023, 8, 1),
        is_champion=True,
    )
    add_stint("season_team_mismatch", team_a, past_season)
    add_stint("season_team_mismatch", team_b, current_season)
    add_stint(
        "season_teammate_mismatch",
        team_b,
        past_season,
    )
    add_stint("season_teammate_mismatch", team_a, current_season)
    for definition in SHIPPED_STAT_MILESTONE_DEFINITIONS:
        for player_key in ("guard", "forward"):
            session.add(
                QuizTicTacToeStatMilestonePlayer(
                    milestone_key=definition.key,
                    player_id=players[player_key].id,
                )
            )

    session.commit()
    try:
        yield session, {
            "current_season": current_season,
            "past_season": past_season,
            "teams": teams,
            "players": players,
        }
    finally:
        session.close()
        engine.dispose()


def _create_ttt_game(client: TestClient, target_wins: int = 2) -> dict:
    response = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "local_two_player",
            "target_wins": target_wins,
            "timer_mode": "15s",
            "player1_name": "Player One",
            "player2_name": "Player Two",
        },
    )
    assert response.status_code == 200
    return _action_payload(response)["game"]


@pytest.fixture()
def quick_match_effects(monkeypatch):
    effects = {"started": [], "broadcasts": []}

    def fake_start_timer(game_state: dict) -> None:
        effects["started"].append(game_state["id"])

    async def fake_broadcast_state(game_id: int, game_state: dict, **kwargs):
        effects["broadcasts"].append((game_id, game_state, kwargs))
        return 0

    monkeypatch.setattr(
        quiz_router.tictactoe_realtime,
        "start_timer_from_state",
        fake_start_timer,
    )
    monkeypatch.setattr(
        quiz_router.tictactoe_realtime,
        "broadcast_state",
        fake_broadcast_state,
    )
    return effects


def test_tictactoe_axis_weights_include_achievements_and_sum_to_one():
    assert ttt_service.AXIS_WEIGHTS == {
        axis_type: definition.weight
        for axis_type, definition in ttt_service.AXIS_REGISTRY.items()
    }
    assert sum(ttt_service.AXIS_WEIGHTS.values()) == pytest.approx(1.0)
    assert ttt_service.AXIS_WEIGHTS == {
        "team": 0.50,
        "nationality": 0.11,
        "played_with": 0.18,
        "season": 0.08,
        "position": 0.04,
        "champion": 0.03,
        "stat_milestone": 0.06,
    }


def test_tictactoe_cached_board_selection_matches_uncached_rng(ttt_axis_session):
    db, _ = ttt_axis_session

    for seed in range(20):
        random.seed(seed)
        uncached = ttt_service._select_board_axes_uncached(db)
        ttt_service.reset_board_cache(db)
        random.seed(seed)
        cached = ttt_service._select_board_axes(db)
        assert cached == uncached


def test_tictactoe_board_cache_warm_does_not_advance_rng(ttt_axis_session):
    db, _ = ttt_axis_session
    random.seed(8675309)
    before = random.getstate()

    ttt_service.warm_board_cache(db)

    assert random.getstate() == before


def test_tictactoe_move_validation_uses_cached_cell_player_sets(
    ttt_axis_session,
    monkeypatch,
):
    db, _ = ttt_axis_session
    board_data = ttt_service.warm_board_cache(db)
    row_key, col_key = next(iter(board_data.valid_cells))
    row_axis = {"axis_type": row_key[0], "value": row_key[1]}
    col_axis = {"axis_type": col_key[0], "value": col_key[1]}
    valid_player_ids = ttt_service._get_board_data_cell_player_set(
        board_data,
        row_axis,
        col_axis,
    )
    valid_player_id = next(iter(valid_player_ids))

    def fail_uncached(*args, **kwargs):
        raise AssertionError("covered board-cache cell used uncached validation")

    monkeypatch.setattr(ttt_service, "_player_matches_cell_uncached", fail_uncached)

    assert ttt_service._player_matches_cell(
        db,
        valid_player_id,
        row_axis,
        col_axis,
    )

    invalid_player_id = next(
        (
            player_id
            for (player_id,) in db.query(Player.id).order_by(Player.id).all()
            if player_id not in valid_player_ids
        ),
        None,
    )
    if invalid_player_id is not None:
        assert not ttt_service._player_matches_cell(
            db,
            invalid_player_id,
            row_axis,
            col_axis,
        )


def test_tictactoe_move_validation_falls_back_for_uncached_axes(
    ttt_axis_session,
    monkeypatch,
):
    db, _ = ttt_axis_session
    ttt_service.warm_board_cache(db)
    calls = []

    def fake_uncached(db_arg, player_id, row_axis, col_axis):
        calls.append((db_arg, player_id, row_axis, col_axis))
        return player_id == 123

    monkeypatch.setattr(ttt_service, "_player_matches_cell_uncached", fake_uncached)

    row_axis = {"axis_type": "team", "value": "999998"}
    col_axis = {"axis_type": "team", "value": "999999"}

    assert ttt_service._player_matches_cell(db, 123, row_axis, col_axis)
    assert calls == [(db, 123, row_axis, col_axis)]


def test_tictactoe_cached_validity_is_exhaustive_and_live_equivalent(
    ttt_axis_session,
):
    db, data = ttt_axis_session
    board_data = ttt_service.warm_board_cache(db)
    axes = [
        dict(axis)
        for candidates in board_data.candidates_by_type.values()
        for axis in candidates
    ]
    player_ids = [player.id for player in data["players"].values()]
    seen_type_pairs = set()
    saw_duplicate_axis = False

    for row_index, row_axis in enumerate(axes):
        for col_axis in axes[row_index:]:
            cached_players = set(
                ttt_service._get_board_data_cell_player_set(
                    board_data, row_axis, col_axis
                )
            )
            live_players = _live_player_set_for_cell(
                db, player_ids, row_axis, col_axis
            )
            cached_valid = ttt_service._board_data_has_valid_cell(
                board_data, row_axis, col_axis
            )
            symmetric_valid = ttt_service._board_data_has_valid_cell(
                board_data, col_axis, row_axis
            )

            assert cached_players == live_players
            assert cached_valid == bool(live_players)
            assert symmetric_valid == cached_valid
            if cached_valid:
                assert any(
                    ttt_service._player_matches_cell(
                        db, player_id, row_axis, col_axis
                    )
                    for player_id in cached_players
                )

            type_pair = tuple(sorted((row_axis["axis_type"], col_axis["axis_type"])))
            seen_type_pairs.add(type_pair)
            if ttt_service._axis_key(row_axis) == ttt_service._axis_key(col_axis):
                saw_duplicate_axis = True

    expected_type_pairs = {
        ("champion", "season"),
        ("champion", "team"),
        ("team", "team"),
        ("nationality", "team"),
        ("season", "team"),
        ("nationality", "season"),
        ("played_with", "season"),
        ("season", "season"),
        ("season", "stat_milestone"),
        ("stat_milestone", "team"),
    }
    assert expected_type_pairs <= seen_type_pairs
    assert saw_duplicate_axis

    current_axis = next(
        axis for axis in axes
        if axis["axis_type"] == "season"
        and axis["value"] == str(data["current_season"].id)
    )
    played_with_axis = next(axis for axis in axes if axis["axis_type"] == "played_with")
    current_teammates = ttt_service._get_board_data_cell_player_set(
        board_data, current_axis, played_with_axis
    )
    assert data["players"]["guard"].id in current_teammates
    assert data["players"]["non_overlap"].id not in current_teammates


def test_tictactoe_board_cache_key_normalizes_engine_and_connection_binds(
    tmp_path: Path,
):
    db_path = tmp_path / "cache_key.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    assert engine.pool.__class__.__name__ == "QueuePool"
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    try:
        with SessionLocal() as db:
            board_data = ttt_service.warm_board_cache(db)
            assert ttt_service._board_cache_engine_for_session(db) is engine
            assert board_data.engine_pool_id == id(engine.pool)

        with engine.connect() as connection:
            ConnectionSession = sessionmaker(
                autocommit=False,
                autoflush=False,
                bind=connection,
            )
            with ConnectionSession() as db:
                assert ttt_service._board_cache_engine_for_session(db) is engine
                assert ttt_service.warm_board_cache(db) is board_data
    finally:
        engine.dispose()


def test_tictactoe_board_cache_rebuilds_after_engine_dispose(tmp_path: Path):
    db_path = tmp_path / "disposed_engine.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    try:
        with SessionLocal() as db:
            before_dispose = ttt_service.warm_board_cache(db)
        old_pool_id = before_dispose.engine_pool_id

        engine.dispose()
        assert id(engine.pool) != old_pool_id

        with SessionLocal() as db:
            after_dispose = ttt_service.warm_board_cache(db)
        assert after_dispose is not before_dispose
        assert after_dispose.engine_pool_id == id(engine.pool)
    finally:
        engine.dispose()


def test_tictactoe_board_generation_cannot_mutate_cached_candidates(
    ttt_axis_session,
):
    db, _ = ttt_axis_session
    board_data = ttt_service.warm_board_cache(db)

    axes = ttt_service._select_board_axes(db)
    axes[0]["display_label"] = "Poisoned"
    cached_axis = next(
        axis
        for axis in board_data.candidates_by_type[axes[0]["axis_type"]]
        if axis["value"] == axes[0]["value"]
    )

    assert cached_axis["display_label"] != "Poisoned"
    with pytest.raises(TypeError):
        cached_axis["display_label"] = "Still Poisoned"


def test_tictactoe_startup_warm_skips_by_default_under_pytest(monkeypatch):
    calls = []

    def fail_if_called(db):
        calls.append(db)
        raise AssertionError("startup warm should be skipped under pytest")

    previous_override = app.dependency_overrides.pop(get_db, None)
    monkeypatch.setattr(
        app.state,
        "enable_tictactoe_board_cache_warm_in_tests",
        False,
        raising=False,
    )
    monkeypatch.setattr(app_main.tictactoe_service, "warm_board_cache", fail_if_called)
    try:
        app_main._warm_tictactoe_board_cache(app)
    finally:
        if previous_override is not None:
            app.dependency_overrides[get_db] = previous_override

    assert calls == []


def test_tictactoe_startup_warm_uses_get_db_override(
    tmp_path: Path,
    monkeypatch,
):
    db_path = tmp_path / "startup_warm.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)
    calls = []

    def override_get_db():
        db = SessionLocal()
        calls.append("opened")
        try:
            yield db
        finally:
            calls.append("closed")
            db.close()

    previous_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(
        app.state,
        "enable_tictactoe_board_cache_warm_in_tests",
        True,
        raising=False,
    )
    try:
        app_main._warm_tictactoe_board_cache(app)
    finally:
        if previous_override is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous_override
        engine.dispose()

    assert calls == ["opened", "closed"]


def test_tictactoe_startup_warm_logs_failures(
    tmp_path: Path,
    monkeypatch,
    caplog,
):
    db_path = tmp_path / "startup_warm_failure.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def fail_warm(db):
        raise RuntimeError("warm failed")

    previous_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(app_main.tictactoe_service, "warm_board_cache", fail_warm)
    monkeypatch.setattr(
        app.state,
        "enable_tictactoe_board_cache_warm_in_tests",
        True,
        raising=False,
    )
    try:
        with caplog.at_level(logging.ERROR, logger="app.main"):
            app_main._warm_tictactoe_board_cache(app)
    finally:
        if previous_override is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous_override
        engine.dispose()

    assert "Failed to warm TicTacToe board cache" in caplog.text


def test_tictactoe_existing_axis_builders_and_matchers(ttt_axis_session):
    db, data = ttt_axis_session
    current_season = data["current_season"]
    past_season = data["past_season"]
    team_a = data["teams"][0]
    players = data["players"]

    team_axis = {
        "axis_type": "team",
        "value": str(team_a.id),
        "display_label": team_a.name,
    }
    nationality_axis = {
        "axis_type": "nationality",
        "value": "CountryA",
        "display_label": "CountryA",
    }
    played_with_axis = {
        "axis_type": "played_with",
        "value": str(players["star"].id),
        "display_label": "Star Guard",
    }
    past_season_axis = {
        "axis_type": "season",
        "value": str(past_season.id),
        "display_label": "2023/24",
    }
    season_axis = {
        "axis_type": "season",
        "value": str(current_season.id),
        "display_label": "2024/25",
    }

    team_players = ttt_service._get_player_set_for_axis(db, team_axis)
    assert players["guard"].id in team_players
    assert players["team_past_only"].id in team_players
    assert ttt_service._player_matches_axis(db, players["guard"].id, team_axis)

    nationality_players = ttt_service._get_player_set_for_axis(db, nationality_axis)
    assert players["guard"].id in nationality_players
    assert players["forward"].id not in nationality_players
    assert ttt_service._player_matches_axis(
        db, players["guard"].id, nationality_axis
    )
    assert not ttt_service._player_matches_axis(
        db, players["forward"].id, nationality_axis
    )

    teammates = ttt_service._get_player_set_for_axis(db, played_with_axis)
    assert players["guard"].id in teammates
    assert players["star"].id not in teammates
    assert players["non_overlap"].id not in teammates
    assert ttt_service._player_matches_axis(db, players["guard"].id, played_with_axis)
    assert not ttt_service._player_matches_axis(
        db, players["non_overlap"].id, played_with_axis
    )

    season_players = ttt_service._get_player_set_for_axis(db, season_axis)
    assert players["guard"].id in season_players
    assert players["team_past_only"].id not in season_players
    assert ttt_service._player_matches_axis(db, players["guard"].id, season_axis)
    assert not ttt_service._player_matches_axis(
        db, players["team_past_only"].id, season_axis
    )


def test_tictactoe_season_cross_axis_behaviour_remains_precise(ttt_axis_session):
    db, data = ttt_axis_session
    current_season = data["current_season"]
    past_season = data["past_season"]
    team_a = data["teams"][0]
    players = data["players"]

    current_axis = {
        "axis_type": "season",
        "value": str(current_season.id),
        "display_label": "2024/25",
    }
    past_axis = {
        "axis_type": "season",
        "value": str(past_season.id),
        "display_label": "2023/24",
    }
    team_axis = {
        "axis_type": "team",
        "value": str(team_a.id),
        "display_label": team_a.name,
    }
    played_with_axis = {
        "axis_type": "played_with",
        "value": str(players["star"].id),
        "display_label": "Star Guard",
    }
    nationality_axis = {
        "axis_type": "nationality",
        "value": "CountryA",
        "display_label": "CountryA",
    }
    position_axis = {
        "axis_type": "position",
        "value": "Forward",
        "display_label": "Forward",
    }

    current_team_players = ttt_service._get_player_set_for_cell(
        db, current_axis, team_axis
    )
    assert players["guard"].id in current_team_players
    assert players["team_past_only"].id not in current_team_players
    assert ttt_service._player_matches_cell(
        db, players["guard"].id, current_axis, team_axis
    )
    assert not ttt_service._player_matches_cell(
        db, players["team_past_only"].id, current_axis, team_axis
    )

    current_teammates = ttt_service._get_player_set_for_cell(
        db, current_axis, played_with_axis
    )
    assert players["guard"].id in current_teammates
    assert players["past_teammate"].id not in current_teammates
    assert players["non_overlap"].id not in current_teammates
    assert ttt_service._player_matches_cell(
        db, players["guard"].id, current_axis, played_with_axis
    )
    assert not ttt_service._player_matches_cell(
        db, players["past_teammate"].id, current_axis, played_with_axis
    )
    assert players["past_teammate"].id in ttt_service._get_player_set_for_cell(
        db, past_axis, played_with_axis
    )

    current_country_players = ttt_service._get_player_set_for_cell(
        db, current_axis, nationality_axis
    )
    assert players["guard"].id in current_country_players
    assert players["nationality_past_only"].id not in current_country_players

    current_forward_players = ttt_service._get_player_set_for_cell(
        db, current_axis, position_axis
    )
    assert players["forward"].id in current_forward_players
    assert players["team_past_only"].id not in current_forward_players
    assert players["blank_position"].id not in current_forward_players
    assert ttt_service._player_matches_cell(
        db, players["forward"].id, current_axis, position_axis
    )
    assert not ttt_service._player_matches_cell(
        db, players["team_past_only"].id, current_axis, position_axis
    )


def test_tictactoe_position_provider_builder_and_matcher_exclude_missing(
    ttt_axis_session,
):
    db, data = ttt_axis_session
    players = data["players"]

    candidates = ttt_service._get_position_candidates(db)
    assert candidates == [
        {"axis_type": "position", "value": "Guard", "display_label": "Guard"},
        {"axis_type": "position", "value": "Forward", "display_label": "Forward"},
        {"axis_type": "position", "value": "Center", "display_label": "Center"},
    ]

    guard_axis = {
        "axis_type": "position",
        "value": "Guard",
        "display_label": "Guard",
    }
    guard_players = ttt_service._get_player_set_for_axis(db, guard_axis)
    assert players["star"].id in guard_players
    assert players["guard"].id in guard_players
    assert players["forward"].id not in guard_players
    assert players["blank_position"].id not in guard_players
    assert players["null_position"].id not in guard_players
    assert ttt_service._player_matches_axis(db, players["guard"].id, guard_axis)
    assert not ttt_service._player_matches_axis(
        db, players["blank_position"].id, guard_axis
    )
    assert not ttt_service._player_matches_axis(
        db, players["null_position"].id, guard_axis
    )


def test_tictactoe_achievement_providers_builders_matchers_and_loose_cells(
    ttt_axis_session,
):
    db, data = ttt_axis_session
    players = data["players"]
    current_season = data["current_season"]
    team_b = data["teams"][1]
    title_team = data["teams"][2]
    team_f = data["teams"][5]

    champion_candidates = ttt_service._get_champion_candidates(db)
    assert champion_candidates == [
        {
            "axis_type": "champion",
            "value": "euroleague_champion",
            "display_label": "EuroLeague champion",
        }
    ]
    champion_axis = champion_candidates[0]

    stat_candidates = ttt_service._get_stat_milestone_candidates(db)
    assert [candidate["value"] for candidate in stat_candidates] == [
        definition.key for definition in SHIPPED_STAT_MILESTONE_DEFINITIONS
    ]
    assert [candidate["display_label"] for candidate in stat_candidates] == [
        definition.display_label for definition in SHIPPED_STAT_MILESTONE_DEFINITIONS
    ]
    stat_axis = stat_candidates[0]

    champion_players = ttt_service._get_player_set_for_axis(db, champion_axis)
    assert players["star"].id in champion_players
    assert players["guard"].id not in champion_players
    assert ttt_service._player_matches_axis(db, players["star"].id, champion_axis)
    assert not ttt_service._player_matches_axis(db, players["guard"].id, champion_axis)

    stat_players = ttt_service._get_player_set_for_axis(db, stat_axis)
    assert players["guard"].id in stat_players
    assert players["star"].id not in stat_players
    assert ttt_service._player_matches_axis(db, players["guard"].id, stat_axis)
    assert not ttt_service._player_matches_axis(db, players["star"].id, stat_axis)

    for axis in (champion_axis, stat_axis):
        axis_players = ttt_service._get_player_set_for_axis(db, axis)
        assert {
            player.id
            for player in players.values()
            if ttt_service._player_matches_axis(db, player.id, axis)
        } == axis_players

    title_team_axis = {
        "axis_type": "team",
        "value": str(title_team.id),
        "display_label": title_team.name,
    }
    other_team_axis = {
        "axis_type": "team",
        "value": str(team_b.id),
        "display_label": team_b.name,
    }
    current_season_axis = {
        "axis_type": "season",
        "value": str(current_season.id),
        "display_label": "2024/25",
    }
    milestone_team_axis = {
        "axis_type": "team",
        "value": str(team_f.id),
        "display_label": team_f.name,
    }

    assert players["star"].id in ttt_service._get_player_set_for_cell(
        db, champion_axis, title_team_axis
    )
    assert players["star"].id in ttt_service._get_player_set_for_cell(
        db, champion_axis, other_team_axis
    )
    assert ttt_service._player_matches_cell(
        db, players["star"].id, champion_axis, other_team_axis
    )
    assert players["star"].id in ttt_service._get_player_set_for_cell(
        db, champion_axis, current_season_axis
    )
    assert ttt_service._player_matches_cell(
        db, players["star"].id, champion_axis, current_season_axis
    )

    assert players["guard"].id in ttt_service._get_player_set_for_cell(
        db, stat_axis, milestone_team_axis
    )
    assert ttt_service._player_matches_cell(
        db, players["guard"].id, stat_axis, milestone_team_axis
    )


def test_tictactoe_feedback_explains_champion_played_with_non_overlap(
    ttt_axis_session,
):
    db, data = ttt_axis_session
    players = data["players"]
    player = players["champion_non_teammate"]
    champion_axis = ttt_service._get_champion_candidates(db)[0]
    played_with_axis = {
        "axis_type": "played_with",
        "value": str(players["star"].id),
        "display_label": "Star Guard",
    }

    assert ttt_service._player_matches_axis(db, player.id, champion_axis)
    assert not ttt_service._player_matches_axis(db, player.id, played_with_axis)
    assert not ttt_service._player_matches_cell(
        db,
        player.id,
        champion_axis,
        played_with_axis,
    )

    feedback = ttt_service._build_incorrect_move_feedback(
        db,
        player,
        champion_axis,
        played_with_axis,
    )

    assert feedback["message"] == (
        "Champion Nonteammate matched the row clue EuroLeague champion, "
        "but not the column clue Played with Star Guard."
    )
    assert feedback["matched_axes"] == [
        {
            "side": "row",
            "axis_type": "champion",
            "value": "euroleague_champion",
            "display_label": "EuroLeague champion",
            "label": "EuroLeague champion",
        }
    ]
    assert feedback["failed_axes"] == [
        {
            "side": "column",
            "axis_type": "played_with",
            "value": str(players["star"].id),
            "display_label": "Star Guard",
            "label": "Played with Star Guard",
        }
    ]


def test_tictactoe_feedback_season_context_qualifies_failed_axis(
    ttt_axis_session,
):
    db, data = ttt_axis_session
    current_season = data["current_season"]
    past_season = data["past_season"]
    team_a = data["teams"][0]
    players = data["players"]
    season_axis = {
        "axis_type": "season",
        "value": str(current_season.id),
        "display_label": "2024/25",
    }
    past_season_axis = {
        "axis_type": "season",
        "value": str(past_season.id),
        "display_label": "2023/24",
    }
    team_axis = {
        "axis_type": "team",
        "value": str(team_a.id),
        "display_label": team_a.name,
    }
    played_with_axis = {
        "axis_type": "played_with",
        "value": str(players["star"].id),
        "display_label": "Star Guard",
    }

    team_mismatch = players["season_team_mismatch"]
    assert ttt_service._player_matches_axis(db, team_mismatch.id, season_axis)
    assert ttt_service._player_matches_axis(db, team_mismatch.id, team_axis)
    assert not ttt_service._player_matches_cell(
        db,
        team_mismatch.id,
        season_axis,
        team_axis,
    )
    team_feedback = ttt_service._build_incorrect_move_feedback(
        db,
        team_mismatch,
        season_axis,
        team_axis,
    )
    assert team_feedback["message"] == (
        "Season TeamMismatch matched the row clue 2024/25, "
        "but not the column clue Axis Team 1 in 2024/25."
    )
    assert team_feedback["failed_axes"] == [
        {
            "side": "column",
            "axis_type": "team",
            "value": str(team_a.id),
            "display_label": team_a.name,
            "label": "Axis Team 1 in 2024/25",
        }
    ]

    teammate_mismatch = players["season_teammate_mismatch"]
    assert ttt_service._player_matches_axis(db, teammate_mismatch.id, past_season_axis)
    assert ttt_service._player_matches_axis(
        db,
        teammate_mismatch.id,
        played_with_axis,
    )
    assert not ttt_service._player_matches_cell(
        db,
        teammate_mismatch.id,
        past_season_axis,
        played_with_axis,
    )
    teammate_feedback = ttt_service._build_incorrect_move_feedback(
        db,
        teammate_mismatch,
        past_season_axis,
        played_with_axis,
    )
    assert teammate_feedback["message"] == (
        "Season TeammateMismatch matched the row clue 2023/24, "
        "but not the column clue Played with Star Guard in 2023/24."
    )
    assert teammate_feedback["failed_axes"] == [
        {
            "side": "column",
            "axis_type": "played_with",
            "value": str(players["star"].id),
            "display_label": "Star Guard",
            "label": "Played with Star Guard in 2023/24",
        }
    ]


def test_tictactoe_board_generation_can_include_position_with_cap_and_answers(
    ttt_axis_session,
    monkeypatch,
):
    db, _ = ttt_axis_session

    def choose_position(*args, **kwargs):
        return ["position"]

    monkeypatch.setattr(ttt_service.random, "choices", choose_position)

    axes = ttt_service._select_board_axes(db)

    assert sum(axis["axis_type"] == "position" for axis in axes) == 1
    row_axes = axes[:3]
    col_axes = axes[3:]
    for row_axis in row_axes:
        for col_axis in col_axes:
            assert ttt_service._get_player_set_for_cell(db, row_axis, col_axis)


@pytest.mark.parametrize("chosen_type", ["champion", "stat_milestone"])
def test_tictactoe_board_generation_can_include_achievement_with_cap_and_answers(
    ttt_axis_session,
    monkeypatch,
    chosen_type,
):
    db, _ = ttt_axis_session

    def choose_achievement(*args, **kwargs):
        return [chosen_type]

    monkeypatch.setattr(ttt_service.random, "choices", choose_achievement)

    axes = ttt_service._select_board_axes(db)

    assert sum(axis["axis_type"] == chosen_type for axis in axes) == 1
    assert sum(
        axis["axis_type"] in ttt_service.ACHIEVEMENT_LIMITED_AXIS_TYPES
        for axis in axes
    ) == 1
    row_axes = axes[:3]
    col_axes = axes[3:]
    for row_axis in row_axes:
        for col_axis in col_axes:
            assert ttt_service._get_player_set_for_cell(db, row_axis, col_axis)


def test_tictactoe_board_generation_rejects_second_achievement_axis(
    ttt_axis_session,
    monkeypatch,
):
    db, _ = ttt_axis_session
    chosen_types = iter(["champion", "stat_milestone", "champion"])

    def choose_mixed_achievements(*args, **kwargs):
        return [next(chosen_types, "team")]

    monkeypatch.setattr(ttt_service.random, "choices", choose_mixed_achievements)

    axes = ttt_service._select_board_axes(db)

    assert sum(
        axis["axis_type"] in ttt_service.ACHIEVEMENT_LIMITED_AXIS_TYPES
        for axis in axes
    ) == 1
    row_axes = axes[:3]
    col_axes = axes[3:]
    for row_axis in row_axes:
        for col_axis in col_axes:
            assert ttt_service._get_player_set_for_cell(db, row_axis, col_axis)


def test_tictactoe_season_position_submit_move_accepts_valid_player(
    ttt_axis_session,
    monkeypatch,
):
    db, data = ttt_axis_session
    current_season = data["current_season"]
    teams = data["teams"]
    players = data["players"]
    forced_axes = [
        {
            "axis_type": "season",
            "value": str(current_season.id),
            "display_label": "2024/25",
        },
        {
            "axis_type": "team",
            "value": str(teams[1].id),
            "display_label": teams[1].name,
        },
        {
            "axis_type": "team",
            "value": str(teams[2].id),
            "display_label": teams[2].name,
        },
        {"axis_type": "position", "value": "Forward", "display_label": "Forward"},
        {
            "axis_type": "team",
            "value": str(teams[3].id),
            "display_label": teams[3].name,
        },
        {
            "axis_type": "team",
            "value": str(teams[4].id),
            "display_label": teams[4].name,
        },
    ]
    monkeypatch.setattr(ttt_service, "_select_board_axes", lambda db: forced_axes)

    game = ttt_service.create_game(
        db,
        mode="local_two_player",
        target_wins=2,
        timer_mode="unlimited",
        player1_name="Player One",
        player2_name="Player Two",
    )

    incorrect = ttt_service.submit_move(
        db,
        game=game,
        row_index=0,
        col_index=0,
        player_id=players["blank_position"].id,
    )
    assert incorrect == "incorrect"

    correct = ttt_service.submit_move(
        db,
        game=game,
        row_index=0,
        col_index=0,
        player_id=players["forward"].id,
    )
    assert correct == "correct"


def test_tictactoe_axis_caps_include_generic_achievement_hook():
    def candidate_provider(db):
        return []

    def player_set_builder(db, axis):
        return set()

    def matcher(db, player_id, axis):
        return False

    synthetic_registry = {
        axis_type: ttt_service.AxisDefinition(
            axis_type=axis_type,
            weight=1.0,
            candidate_provider=candidate_provider,
            player_set_builder=player_set_builder,
            matcher=matcher,
        )
        for axis_type in ("champion", "stat_milestone")
    }

    assert ttt_service._axis_counts_within_board_caps(
        [{"axis_type": "champion"}],
        registry=synthetic_registry,
    )
    assert not ttt_service._axis_counts_within_board_caps(
        [{"axis_type": "champion"}, {"axis_type": "stat_milestone"}],
        registry=synthetic_registry,
    )
    assert not ttt_service._axis_type_can_be_added(
        [{"axis_type": "champion"}],
        "stat_milestone",
        registry=synthetic_registry,
    )


def test_create_tictactoe_game_has_board(client: TestClient):
    payload = _create_ttt_game(client)
    assert payload["mode"] == "local_two_player"
    assert payload["is_public"] is False
    assert payload["preset"] is None
    assert payload["round"]["status"] == "active"
    assert len(payload["round"]["rows"]) == 3
    assert len(payload["round"]["columns"]) == 3
    assert len(payload["round"]["cells"]) == 9


@pytest.mark.parametrize(
    ("achievement_axis_type", "achievement_value", "achievement_label"),
    [
        ("champion", "euroleague_champion", "EuroLeague champion"),
        (
            "stat_milestone",
            SHIPPED_STAT_MILESTONE_DEFINITIONS[0].key,
            SHIPPED_STAT_MILESTONE_DEFINITIONS[0].display_label,
        ),
    ],
)
def test_tictactoe_create_serializes_achievement_axes_with_existing_shape(
    client: TestClient,
    monkeypatch,
    achievement_axis_type,
    achievement_value,
    achievement_label,
):
    with client.session_local() as db:
        teams = db.query(Team).order_by(Team.id).limit(5).all()

    achievement_axis = {
        "axis_type": achievement_axis_type,
        "value": achievement_value,
        "display_label": achievement_label,
    }
    forced_axes = [
        achievement_axis,
        *[
            {
                "axis_type": "team",
                "value": str(team.id),
                "display_label": team.short_name or team.name,
            }
            for team in teams
        ],
    ]
    monkeypatch.setattr(ttt_service, "_select_board_axes", lambda db: forced_axes)

    response = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "local_two_player",
            "target_wins": 2,
            "timer_mode": "15s",
        },
    )

    assert response.status_code == 200
    game = _action_payload(response)["game"]
    row_axis = game["round"]["rows"][0]
    cell_axis = _find_cell(game, 0, 0)["row_axis"]
    assert row_axis == achievement_axis
    assert cell_axis == achievement_axis
    assert set(row_axis) == {"axis_type", "value", "display_label"}
    assert set(cell_axis) == {"axis_type", "value", "display_label"}


def test_tictactoe_timing_disabled_by_default_has_no_server_timing_header(
    client: TestClient,
):
    response = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "local_two_player",
            "target_wins": 2,
            "timer_mode": "15s",
        },
    )

    assert response.status_code == 200
    assert response.headers.get("server-timing") is None


def test_tictactoe_debug_logging_does_not_emit_server_timing_without_flag(
    client: TestClient,
    caplog,
):
    with caplog.at_level(logging.DEBUG, logger="app.routers.quiz"):
        response = client.post(
            "/quiz/tictactoe/games",
            json={
                "mode": "local_two_player",
                "target_wins": 2,
                "timer_mode": "15s",
            },
        )

    assert response.status_code == 200
    assert response.headers.get("server-timing") is None
    assert any(
        record.tictactoe_timing["attributes"]["action"] == "create"
        for record in caplog.records
        if hasattr(record, "tictactoe_timing")
    )


def test_tictactoe_create_timing_header_covers_board_commit_and_serialization(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(quiz_router.settings, "tictactoe_timing_enabled", True)

    response = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "local_two_player",
            "target_wins": 2,
            "timer_mode": "15s",
        },
    )

    assert response.status_code == 200
    header = response.headers["server-timing"]
    assert "board_reference_data;dur=" in header
    assert "board_axis_selection;dur=" in header
    assert "board_axis_selection_attempts" in header
    assert "db_commit;dur=" in header
    assert "response_state_serialization;dur=" in header
    assert "response_serialization;dur=" in header


def test_tictactoe_move_timing_header_covers_validation_and_completed_answers(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(quiz_router.settings, "tictactoe_timing_enabled", True)
    game = _create_ttt_game(client, target_wins=2)
    game_id = game["id"]
    final_response = None

    for row_index, col_index in ((0, 0), (1, 1), (2, 2)):
        latest_state = client.get(f"/quiz/tictactoe/games/{game_id}").json()
        cell = _find_cell(latest_state, row_index, col_index)
        player_id = _valid_player_for_cell(client, cell)
        final_response = client.post(
            f"/quiz/tictactoe/games/{game_id}/moves",
            json={
                "row_index": row_index,
                "col_index": col_index,
                "player_id": player_id,
            },
        )
        assert final_response.status_code == 200
        result = _action_payload(final_response)
        if row_index != 2:
            bad_cell = _find_cell(result["game"], 0, 1)
            bad_player = _invalid_player_for_cell(client, bad_cell)
            if bad_player is not None:
                incorrect = client.post(
                    f"/quiz/tictactoe/games/{game_id}/moves",
                    json={
                        "row_index": 0,
                        "col_index": 1,
                        "player_id": bad_player,
                    },
                )
                assert incorrect.status_code == 200

    assert final_response is not None
    payload = _action_payload(final_response)
    assert payload["result"] == "round_won"
    header = final_response.headers["server-timing"]
    assert "move_player_matches_cell;dur=" in header
    assert "completed_round_sample_answers;dur=" in header
    assert "db_commit;dur=" in header
    assert "response_completed_round_serialization;dur=" in header
    assert "response_serialization;dur=" in header


def test_tictactoe_completed_round_uses_batched_sample_answers(
    client: TestClient,
    monkeypatch,
):
    def fail_per_cell_sample_helper(*args, **kwargs):
        raise AssertionError("completed round used per-cell sample helper")

    monkeypatch.setattr(
        ttt_service,
        "_get_sample_answers",
        fail_per_cell_sample_helper,
    )
    response = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "single_player",
            "target_wins": 2,
            "timer_mode": "15s",
        },
    )
    assert response.status_code == 200
    game = _action_payload(response)["game"]
    game_id = game["id"]
    final_response = None

    for row_index, col_index in ((0, 0), (1, 1), (2, 2)):
        latest_state = client.get(f"/quiz/tictactoe/games/{game_id}").json()
        cell = _find_cell(latest_state, row_index, col_index)
        player_id = _valid_player_for_cell(client, cell)
        final_response = client.post(
            f"/quiz/tictactoe/games/{game_id}/moves",
            json={
                "row_index": row_index,
                "col_index": col_index,
                "player_id": player_id,
            },
        )
        assert final_response.status_code == 200

    assert final_response is not None
    payload = _action_payload(final_response)
    assert payload["result"] == "board_complete"
    assert payload["completed_round"]["round_number"] == 1
    for cell in payload["completed_round"]["cells"]:
        assert isinstance(cell["sample_answers"], list)


def test_tictactoe_timing_header_is_attached_to_domain_errors(
    client: TestClient,
    monkeypatch,
):
    monkeypatch.setattr(quiz_router.settings, "tictactoe_timing_enabled", True)

    response = client.post(
        "/quiz/tictactoe/games/999/moves",
        json={
            "row_index": 0,
            "col_index": 0,
            "player_id": 1,
        },
    )

    assert response.status_code == 404
    assert "response_serialization;dur=" in response.headers["server-timing"]


def test_quick_match_first_request_waits_with_public_preset(client: TestClient):
    response = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "blitz",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )

    assert response.status_code == 200
    game = _action_payload(response)["game"]
    assert game["status"] == "waiting_for_opponent"
    assert game["mode"] == "online_friend"
    assert game["is_public"] is True
    assert game["preset"] == "blitz"
    assert game["target_wins"] == 3
    assert game["turn_seconds"] == 15
    assert game["round"] is None
    assert "guest_id" not in game
    assert "player1_guest_id" not in game


def test_quick_match_pools_endpoint_returns_empty_registered_presets(client: TestClient):
    response = client.get("/quiz/tictactoe/quick-match/pools")

    assert response.status_code == 200
    assert response.json() == {
        "pools": {
            "blitz": {"searching": 0, "in_progress": 0},
            "standard": {"searching": 0, "in_progress": 0},
            "long": {"searching": 0, "in_progress": 0},
        },
        "poll_interval_seconds": 5,
    }


def test_quick_match_pools_endpoint_tracks_waiting_active_cancel_and_finish(
    client: TestClient,
    quick_match_effects,
):
    first = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )
    assert first.status_code == 200
    standard_game = _action_payload(first)["game"]

    waiting_counts = client.get("/quiz/tictactoe/quick-match/pools")
    assert waiting_counts.status_code == 200
    assert waiting_counts.json()["pools"]["standard"] == {
        "searching": 1,
        "in_progress": 0,
    }

    second = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Joiner",
            "guest_id": "joiner-guest",
        },
    )
    assert second.status_code == 200

    active_counts = client.get("/quiz/tictactoe/quick-match/pools")
    assert active_counts.status_code == 200
    assert active_counts.json()["pools"]["standard"] == {
        "searching": 0,
        "in_progress": 1,
    }

    long_search = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "long",
            "player_name": "Long Host",
            "guest_id": "long-host-guest",
        },
    )
    assert long_search.status_code == 200
    long_game = _action_payload(long_search)["game"]

    mixed_counts = client.get("/quiz/tictactoe/quick-match/pools")
    assert mixed_counts.status_code == 200
    assert mixed_counts.json()["pools"]["standard"] == {
        "searching": 0,
        "in_progress": 1,
    }
    assert mixed_counts.json()["pools"]["long"] == {
        "searching": 1,
        "in_progress": 0,
    }

    cancel = client.post(
        "/quiz/tictactoe/quick-match/cancel",
        json={
            "preset": "long",
            "game_id": long_game["id"],
            "guest_id": "long-host-guest",
        },
    )
    assert cancel.status_code == 200

    with client.session_local() as db:
        game = db.get(QuizTicTacToeGame, standard_game["id"])
        game.status = "finished"
        db.commit()

    final_counts = client.get("/quiz/tictactoe/quick-match/pools")
    assert final_counts.status_code == 200
    assert final_counts.json()["pools"]["standard"] == {
        "searching": 0,
        "in_progress": 0,
    }
    assert final_counts.json()["pools"]["long"] == {
        "searching": 0,
        "in_progress": 0,
    }


def test_quick_match_pairs_second_guest_and_only_fresh_pair_starts_effects(
    client: TestClient,
    quick_match_effects,
    monkeypatch,
):
    monkeypatch.setattr(matchmaking, "random_starting_player", lambda: 2)

    first = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )
    assert first.status_code == 200
    waiting_game = _action_payload(first)["game"]

    second = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Joiner",
            "guest_id": "joiner-guest",
        },
    )

    assert second.status_code == 200
    matched_game = _action_payload(second)["game"]
    assert matched_game["id"] == waiting_game["id"]
    assert matched_game["status"] == "active"
    assert matched_game["player1_name"] == "Host"
    assert matched_game["player2_name"] == "Joiner"
    assert matched_game["current_player"] == 2
    assert matched_game["round"] is not None
    assert matched_game["is_public"] is True
    assert matched_game["preset"] == "standard"
    assert matched_game["target_wins"] == 3
    assert matched_game["turn_seconds"] == 40
    assert "guest_id" not in matched_game
    assert "player1_guest_id" not in matched_game
    assert "player2_guest_id" not in matched_game
    assert quick_match_effects["started"] == [matched_game["id"]]
    assert [item[0] for item in quick_match_effects["broadcasts"]] == [
        matched_game["id"]
    ]

    with client.session_local() as db:
        db_game = db.get(QuizTicTacToeGame, matched_game["id"])
        assert db_game.player1_guest_id == "host-guest"
        assert db_game.player2_guest_id == "joiner-guest"

    retry = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Host Again",
            "guest_id": "host-guest",
        },
    )

    assert retry.status_code == 200
    retry_game = _action_payload(retry)["game"]
    assert retry_game["id"] == matched_game["id"]
    assert retry_game["status"] == "active"
    assert quick_match_effects["started"] == [matched_game["id"]]
    assert len(quick_match_effects["broadcasts"]) == 1


def test_quick_match_randomized_starting_player_can_choose_either_player(
    client: TestClient,
    quick_match_effects,
    monkeypatch,
):
    starting_players = iter([1, 2, 1, 2])
    monkeypatch.setattr(
        matchmaking,
        "random_starting_player",
        lambda: next(starting_players),
    )
    observed = []

    for index in range(4):
        first = client.post(
            "/quiz/tictactoe/quick-match",
            json={
                "preset": "standard",
                "player_name": f"Host {index}",
                "guest_id": f"host-guest-{index}",
            },
        )
        assert first.status_code == 200
        waiting_game = _action_payload(first)["game"]
        assert waiting_game["status"] == "waiting_for_opponent"

        second = client.post(
            "/quiz/tictactoe/quick-match",
            json={
                "preset": "standard",
                "player_name": f"Joiner {index}",
                "guest_id": f"joiner-guest-{index}",
            },
        )
        assert second.status_code == 200
        matched_game = _action_payload(second)["game"]
        assert matched_game["id"] == waiting_game["id"]
        assert matched_game["status"] == "active"
        observed.append(matched_game["current_player"])

    assert observed == [1, 2, 1, 2]
    assert len(quick_match_effects["started"]) == 4
    assert len(quick_match_effects["broadcasts"]) == 4


@pytest.mark.asyncio
async def test_tictactoe_disconnect_grace_forfeits_real_quick_match_game(
    client: TestClient,
):
    with client.session_local() as db:
        game = ttt_service.create_game(
            db,
            mode="online_friend",
            target_wins=3,
            timer_mode="40s",
            player1_name="Host",
            guest_id="host-guest",
        )
        game.is_public = True
        game.preset = "standard"
        ttt_service.join_game(
            db,
            game.join_code,
            "Joiner",
            guest_id="joiner-guest",
            started_by_player=1,
        )
        game_id = game.id
        db.commit()

    grace_sleep = SleepController()
    module = OnlineGameRealtimeModule(
        TicTacToeRealtimeAdapter(),
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
        finished_game = db.get(QuizTicTacToeGame, game_id)
        assert finished_game.status == "finished"
        assert finished_game.winner_player == 2

    assert not module.disconnect_grace_timer.has_game_timer(game_id)
    message = opponent.sent[-1]
    RealtimeServerMessageAdapter.validate_python(message)
    assert message["payload"]["result"] == "opponent_left"
    assert message["payload"]["terminal"] is True
    assert message["payload"]["game"]["winner_player"] == 2


def test_quick_match_cancel_removes_waiting_game_and_frees_pool(client: TestClient):
    search = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "long",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )
    assert search.status_code == 200
    game = _action_payload(search)["game"]

    cancel = client.post(
        "/quiz/tictactoe/quick-match/cancel",
        json={
            "preset": "long",
            "game_id": game["id"],
            "guest_id": "host-guest",
        },
    )

    assert cancel.status_code == 200
    cancelled_game = _action_payload(cancel)["game"]
    assert cancelled_game["id"] == game["id"]
    assert cancelled_game["status"] == "cancelled"
    assert cancelled_game["preset"] == "long"
    assert cancelled_game["is_public"] is True

    with client.session_local() as db:
        assert db.get(QuizTicTacToeGame, game["id"]) is None

    next_search = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "long",
            "player_name": "Next",
            "guest_id": "next-guest",
        },
    )
    assert next_search.status_code == 200
    assert _action_payload(next_search)["game"]["status"] == "waiting_for_opponent"


def test_quick_match_rejects_unknown_preset_with_error_envelope(client: TestClient):
    response = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "arcade",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )

    assert response.status_code == 400
    assert response.json() == {
        "type": "error",
        "payload": {
            "code": "invalid_input",
            "message": "Unknown TicTacToe matchmaking preset",
        },
    }


def test_quick_match_same_guest_does_not_self_match(
    client: TestClient,
    quick_match_effects,
):
    first = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "First",
            "guest_id": "same-guest",
        },
    )
    assert first.status_code == 200
    first_game = _action_payload(first)["game"]

    second = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Second",
            "guest_id": "same-guest",
        },
    )
    assert second.status_code == 200
    second_game = _action_payload(second)["game"]
    assert second_game["id"] == first_game["id"]
    assert second_game["status"] == "waiting_for_opponent"
    assert quick_match_effects["started"] == []
    assert quick_match_effects["broadcasts"] == []

    third = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Third",
            "guest_id": "other-guest",
        },
    )
    assert third.status_code == 200
    third_game = _action_payload(third)["game"]
    assert third_game["id"] == first_game["id"]
    assert third_game["status"] == "active"


def test_quick_match_cancel_after_match_returns_error_envelope(
    client: TestClient,
    quick_match_effects,
):
    first = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )
    assert first.status_code == 200
    game = _action_payload(first)["game"]

    second = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Joiner",
            "guest_id": "joiner-guest",
        },
    )
    assert second.status_code == 200

    cancel = client.post(
        "/quiz/tictactoe/quick-match/cancel",
        json={
            "preset": "standard",
            "game_id": game["id"],
            "guest_id": "host-guest",
        },
    )

    assert cancel.status_code == 404
    assert cancel.json() == {
        "type": "error",
        "payload": {
            "code": "not_found",
            "message": "Matchmaking search not found",
        },
    }


def test_friend_online_games_are_not_public_or_quick_match_candidates(
    client: TestClient,
):
    friend = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "online_friend",
            "target_wins": 3,
            "timer_mode": "40s",
            "player1_name": "Friend Host",
            "guest_id": "friend-guest",
        },
    )
    assert friend.status_code == 200
    friend_game = _action_payload(friend)["game"]
    assert friend_game["is_public"] is False
    assert friend_game["preset"] is None

    search = client.post(
        "/quiz/tictactoe/quick-match",
        json={
            "preset": "standard",
            "player_name": "Quick Host",
            "guest_id": "quick-guest",
        },
    )
    assert search.status_code == 200
    quick_game = _action_payload(search)["game"]
    assert quick_game["id"] != friend_game["id"]
    assert quick_game["status"] == "waiting_for_opponent"
    assert quick_game["is_public"] is True


def test_submit_correct_and_incorrect_moves_switch_turn(client: TestClient):
    game = _create_ttt_game(client)
    game_id = game["id"]

    cell_00 = _find_cell(game, 0, 0)
    correct_player_id = _valid_player_for_cell(client, cell_00)
    move_1 = client.post(
        f"/quiz/tictactoe/games/{game_id}/moves",
        json={
            "row_index": 0,
            "col_index": 0,
            "player_id": correct_player_id,
        },
    )
    assert move_1.status_code == 200
    move_1_payload = _action_payload(move_1)
    assert move_1_payload["result"] == "correct"
    assert move_1_payload["game"]["current_player"] == 2

    cell_01 = _find_cell(move_1_payload["game"], 0, 1)
    invalid_player_id = _invalid_player_for_cell(client, cell_01)
    if invalid_player_id is not None:
        move_2 = client.post(
            f"/quiz/tictactoe/games/{game_id}/moves",
            json={
                "row_index": 0,
                "col_index": 1,
                "player_id": invalid_player_id,
            },
        )
        assert move_2.status_code == 200
        move_2_payload = _action_payload(move_2)
        assert move_2_payload["result"] == "incorrect"
        assert move_2_payload["game"]["current_player"] == 1

    cell_01_after = _find_cell(move_2_payload["game"], 0, 1)
    assert cell_01_after["claimed_by_player"] is None


def test_tictactoe_incorrect_move_response_includes_feedback(
    client: TestClient,
    monkeypatch,
):
    with client.session_local() as db:
        teams = db.query(Team).order_by(Team.id).limit(5).all()
        bad_player_id = (
            db.query(Player.id)
            .filter(Player.euroleague_code == "P006")
            .scalar()
        )

    forced_axes = [
        {
            "axis_type": "champion",
            "value": "euroleague_champion",
            "display_label": "EuroLeague champion",
        },
        *[
            {
                "axis_type": "team",
                "value": str(team.id),
                "display_label": team.short_name or team.name,
            }
            for team in teams
        ],
    ]
    monkeypatch.setattr(ttt_service, "_select_board_axes", lambda db: forced_axes)
    game = _create_ttt_game(client)

    response = client.post(
        f"/quiz/tictactoe/games/{game['id']}/moves",
        json={
            "row_index": 0,
            "col_index": 0,
            "player_id": bad_player_id,
        },
    )

    assert response.status_code == 200
    payload = _action_payload(response)
    assert payload["result"] == "incorrect"
    assert payload["game"]["current_player"] == 2
    assert payload["feedback"]["message"] == (
        "Frank Gate did not match either the row clue EuroLeague champion "
        "or the column clue Gamma Club."
    )
    assert payload["feedback"]["failed_axes"] == [
        {
            "side": "row",
            "axis_type": "champion",
            "value": "euroleague_champion",
            "display_label": "EuroLeague champion",
            "label": "EuroLeague champion",
        },
        {
            "side": "column",
            "axis_type": "team",
            "value": str(teams[2].id),
            "display_label": teams[2].short_name or teams[2].name,
            "label": teams[2].short_name or teams[2].name,
        },
    ]


def test_draw_offer_accept_starts_new_round(client: TestClient):
    game = _create_ttt_game(client)
    game_id = game["id"]
    starting_round = game["round_number"]

    offer = client.post(f"/quiz/tictactoe/games/{game_id}/draw-offer")
    assert offer.status_code == 200
    offer_payload = _action_payload(offer)
    assert offer_payload["result"] == "draw_offered"
    assert offer_payload["game"]["pending_draw"] == {"offered_by": 1, "respond_to": 2}
    assert offer_payload["game"]["current_player"] == 2

    accept = client.post(
        f"/quiz/tictactoe/games/{game_id}/draw-response",
        json={"accept": True},
    )
    assert accept.status_code == 200
    accept_payload = _action_payload(accept)
    assert accept_payload["result"] == "draw_accepted"
    assert accept_payload["game"]["pending_draw"] is None
    assert accept_payload["game"]["round_number"] == starting_round + 1
    assert accept_payload["game"]["player1_score"] == 0
    assert accept_payload["game"]["player2_score"] == 0


def test_round_win_and_match_win_progression(client: TestClient):
    game = _create_ttt_game(client, target_wins=2)
    game_id = game["id"]

    # Round 1: Player 1 wins on diagonal.
    for row_col in ((0, 0), (1, 1), (2, 2)):
        row_index, col_index = row_col
        latest_state = client.get(f"/quiz/tictactoe/games/{game_id}").json()
        assert latest_state["current_player"] == 1
        cell = _find_cell(latest_state, row_index, col_index)
        player_id = _valid_player_for_cell(client, cell)
        correct_move = client.post(
            f"/quiz/tictactoe/games/{game_id}/moves",
            json={"row_index": row_index, "col_index": col_index, "player_id": player_id},
        )
        assert correct_move.status_code == 200
        result = _action_payload(correct_move)

        if row_col != (2, 2):
            assert result["result"] == "correct"
            next_state = result["game"]
            assert next_state["current_player"] == 2
            bad_cell = _find_cell(next_state, 0, 1)
            bad_player = _invalid_player_for_cell(client, bad_cell)
            if bad_player is not None:
                incorrect_move = client.post(
                    f"/quiz/tictactoe/games/{game_id}/moves",
                    json={"row_index": 0, "col_index": 1, "player_id": bad_player},
                )
                assert incorrect_move.status_code == 200
                assert _action_payload(incorrect_move)["result"] == "incorrect"
        else:
            assert result["result"] == "round_won"
            assert result["game"]["player1_score"] == 1
            assert result["game"]["round_number"] == 2

    # Round 2 starts with Player 2, force an incorrect move first.
    state = client.get(f"/quiz/tictactoe/games/{game_id}").json()
    assert state["current_player"] == 2
    bad_cell = _find_cell(state, 0, 1)
    bad_player = _invalid_player_for_cell(client, bad_cell)
    if bad_player is not None:
        first_move_round_2 = client.post(
            f"/quiz/tictactoe/games/{game_id}/moves",
            json={"row_index": 0, "col_index": 1, "player_id": bad_player},
        )
        assert first_move_round_2.status_code == 200
        assert _action_payload(first_move_round_2)["result"] == "incorrect"

    # Then Player 1 wins another diagonal and finishes the match.
    for row_col in ((0, 0), (1, 1), (2, 2)):
        row_index, col_index = row_col
        latest_state = client.get(f"/quiz/tictactoe/games/{game_id}").json()
        assert latest_state["current_player"] == 1
        cell = _find_cell(latest_state, row_index, col_index)
        player_id = _valid_player_for_cell(client, cell)
        correct_move = client.post(
            f"/quiz/tictactoe/games/{game_id}/moves",
            json={"row_index": row_index, "col_index": col_index, "player_id": player_id},
        )
        assert correct_move.status_code == 200
        result = _action_payload(correct_move)

        if row_col != (2, 2):
            assert result["result"] == "correct"
            next_state = result["game"]
            assert next_state["current_player"] == 2
            bad_cell = _find_cell(next_state, 0, 1)
            bad_player = _invalid_player_for_cell(client, bad_cell)
            if bad_player is not None:
                incorrect_move = client.post(
                    f"/quiz/tictactoe/games/{game_id}/moves",
                    json={"row_index": 0, "col_index": 1, "player_id": bad_player},
                )
                assert incorrect_move.status_code == 200
                assert _action_payload(incorrect_move)["result"] == "incorrect"
        else:
            assert result["result"] == "match_won"
            assert result["game"]["status"] == "finished"
            assert result["game"]["winner_player"] == 1
            assert result["game"]["player1_score"] == 2


def test_online_game_create_and_join(client: TestClient):
    # Create online game
    response = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "online_friend",
            "target_wins": 2,
            "timer_mode": "40s",
            "player1_name": "Host",
        },
    )
    assert response.status_code == 200
    data = _action_payload(response)["game"]
    assert data["status"] == "waiting_for_opponent"
    assert data["join_code"] is not None
    assert len(data["join_code"]) == 6
    assert data["round"] is None  # no board until opponent joins

    join_code = data["join_code"]

    # Join the game
    response2 = client.post(
        "/quiz/tictactoe/games/join",
        json={"join_code": join_code, "player_name": "Joiner"},
    )
    assert response2.status_code == 200
    joined = _action_payload(response2)["game"]
    assert joined["status"] == "active"
    assert joined["player2_name"] == "Joiner"
    assert joined["round"] is not None  # board generated
    assert joined["id"] == data["id"]

    missing_player = client.post(
        f"/quiz/tictactoe/games/{joined['id']}/moves",
        json={"row_index": 0, "col_index": 0, "player_id": 1},
    )
    assert missing_player.status_code == 400
    assert missing_player.json() == {
        "type": "error",
        "payload": {
            "code": "invalid_input",
            "message": "Online game actions require player identity",
        },
    }

    # Cannot join again
    response3 = client.post(
        "/quiz/tictactoe/games/join",
        json={"join_code": join_code, "player_name": "Late"},
    )
    assert response3.status_code == 409
    assert response3.json()["type"] == "error"



def test_online_resign_finishes_game_for_opponent_even_off_turn(client: TestClient):
    create = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "online_friend",
            "target_wins": 2,
            "timer_mode": "40s",
            "player1_name": "Host",
        },
    )
    assert create.status_code == 200
    game = _action_payload(create)["game"]
    join = client.post(
        "/quiz/tictactoe/games/join",
        json={"join_code": game["join_code"], "player_name": "Joiner"},
    )
    assert join.status_code == 200
    joined = _action_payload(join)["game"]
    assert joined["current_player"] == 1

    resign = client.post(f"/quiz/tictactoe/games/{joined['id']}/give-up?player=2")

    assert resign.status_code == 200
    payload = _action_payload(resign)
    assert payload["result"] == "resigned"
    assert payload["terminal"] is True
    assert payload["game"]["status"] == "finished"
    assert payload["game"]["winner_player"] == 1
    assert payload["game"]["pending_draw"] is None


def test_online_game_persists_guest_id(client: TestClient):
    create = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "online_friend",
            "target_wins": 2,
            "timer_mode": "40s",
            "player1_name": "Host",
            "guest_id": "host-guest-123",
        },
    )
    assert create.status_code == 200
    data = _action_payload(create)["game"]
    game_id = data["id"]
    # guest_id is an opaque server-side token; never leak it into game state.
    assert "guest_id" not in data
    assert "player1_guest_id" not in data

    join = client.post(
        "/quiz/tictactoe/games/join",
        json={
            "join_code": data["join_code"],
            "player_name": "Joiner",
            "guest_id": "joiner-guest-456",
        },
    )
    assert join.status_code == 200

    with client.session_local() as db:
        game = db.get(QuizTicTacToeGame, game_id)
        assert game.player1_guest_id == "host-guest-123"
        assert game.player2_guest_id == "joiner-guest-456"


def test_online_game_without_guest_id_still_works(client: TestClient):
    create = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "online_friend",
            "target_wins": 2,
            "timer_mode": "40s",
            "player1_name": "Host",
        },
    )
    assert create.status_code == 200
    data = _action_payload(create)["game"]
    game_id = data["id"]

    join = client.post(
        "/quiz/tictactoe/games/join",
        json={"join_code": data["join_code"], "player_name": "Joiner"},
    )
    assert join.status_code == 200
    assert _action_payload(join)["game"]["status"] == "active"

    with client.session_local() as db:
        game = db.get(QuizTicTacToeGame, game_id)
        assert game.player1_guest_id is None
        assert game.player2_guest_id is None


@pytest.mark.asyncio
async def test_anonymous_online_play_stays_tokenless_across_rest_and_websocket(
    client: TestClient,
    monkeypatch,
):
    def fail_verifier():
        raise AssertionError("Verifier should not run for tokenless websocket play")

    def fail_auth_session_factory():
        raise AssertionError("Auth DB should not open for tokenless websocket play")

    monkeypatch.setattr(realtime_service, "get_clerk_jwt_verifier", fail_verifier)

    create = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "online_friend",
            "target_wins": 2,
            "timer_mode": "unlimited",
            "player1_name": "Anonymous Host",
        },
    )
    assert create.status_code == 200
    created = _action_payload(create)["game"]
    assert "authorization" not in create.request.headers
    assert "guest_id" not in created
    assert "player1_guest_id" not in created

    join = client.post(
        "/quiz/tictactoe/games/join",
        json={"join_code": created["join_code"], "player_name": "Anonymous Joiner"},
    )
    assert join.status_code == 200
    joined = _action_payload(join)["game"]
    assert "authorization" not in join.request.headers
    assert joined["status"] == "active"
    assert joined["round"] is not None
    assert "guest_id" not in joined
    assert "player1_guest_id" not in joined
    assert "player2_guest_id" not in joined

    game_id = joined["id"]
    with client.session_local() as db:
        game = db.get(QuizTicTacToeGame, game_id)
        assert game.player1_guest_id is None
        assert game.player2_guest_id is None

    module = OnlineGameRealtimeModule(
        TicTacToeRealtimeAdapter(),
        session_factory=client.session_local,
        auth_session_factory=fail_auth_session_factory,
    )
    player_one = FakeWebSocket()
    player_two = FakeWebSocket()

    await module._send_initial_state(player_one, game_id, 1)
    await module._send_initial_state(player_two, game_id, 2)

    assert module.connections.get_context(game_id, 1).user is None
    assert module.connections.get_context(game_id, 2).user is None
    RealtimeServerMessageAdapter.validate_python(player_one.sent[0])
    RealtimeServerMessageAdapter.validate_python(player_two.sent[0])

    acting_player = joined["current_player"]
    acting_socket = player_one if acting_player == 1 else player_two
    cell = _find_cell(joined, 0, 0)
    player_id = _valid_player_for_cell(client, cell)

    envelope = await module.handle_client_message(
        acting_socket,
        game_id,
        acting_player,
        {
            "action": RealtimeClientAction.MOVE.value,
            "row_index": 0,
            "col_index": 0,
            "player_id": player_id,
        },
    )

    RealtimeServerMessageAdapter.validate_python(envelope)
    assert envelope["type"] == "state"
    assert envelope["payload"]["game"]["id"] == game_id
    assert envelope["payload"]["result"] in {"correct", "round_won"}
    assert player_one.sent[-1]["payload"]["game"]["id"] == game_id
    assert player_two.sent[-1]["payload"]["game"]["id"] == game_id


@pytest.mark.asyncio
async def test_online_incorrect_move_broadcasts_feedback(
    client: TestClient,
    monkeypatch,
):
    with client.session_local() as db:
        teams = db.query(Team).order_by(Team.id).limit(5).all()
        bad_player_id = (
            db.query(Player.id)
            .filter(Player.euroleague_code == "P006")
            .scalar()
        )

    forced_axes = [
        {
            "axis_type": "champion",
            "value": "euroleague_champion",
            "display_label": "EuroLeague champion",
        },
        *[
            {
                "axis_type": "team",
                "value": str(team.id),
                "display_label": team.short_name or team.name,
            }
            for team in teams
        ],
    ]
    monkeypatch.setattr(ttt_service, "_select_board_axes", lambda db: forced_axes)

    create = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "online_friend",
            "target_wins": 2,
            "timer_mode": "unlimited",
            "player1_name": "Anonymous Host",
        },
    )
    assert create.status_code == 200
    created = _action_payload(create)["game"]
    join = client.post(
        "/quiz/tictactoe/games/join",
        json={"join_code": created["join_code"], "player_name": "Anonymous Joiner"},
    )
    assert join.status_code == 200
    joined = _action_payload(join)["game"]
    game_id = joined["id"]

    module = OnlineGameRealtimeModule(
        TicTacToeRealtimeAdapter(),
        session_factory=client.session_local,
    )
    player_one = FakeWebSocket()
    player_two = FakeWebSocket()
    await module._send_initial_state(player_one, game_id, 1)
    await module._send_initial_state(player_two, game_id, 2)

    acting_player = joined["current_player"]
    acting_socket = player_one if acting_player == 1 else player_two
    envelope = await module.handle_client_message(
        acting_socket,
        game_id,
        acting_player,
        {
            "action": RealtimeClientAction.MOVE.value,
            "row_index": 0,
            "col_index": 0,
            "player_id": bad_player_id,
        },
    )

    RealtimeServerMessageAdapter.validate_python(envelope)
    assert envelope["payload"]["result"] == "incorrect"
    assert envelope["payload"]["feedback"]["message"] == (
        "Frank Gate did not match either the row clue EuroLeague champion "
        "or the column clue Gamma Club."
    )
    assert player_one.sent[-1]["payload"]["feedback"] == envelope["payload"]["feedback"]
    assert player_two.sent[-1]["payload"]["feedback"] == envelope["payload"]["feedback"]


def test_online_game_oversized_guest_id_is_clamped_not_rejected(client: TestClient):
    oversized = "g" * 200
    create = client.post(
        "/quiz/tictactoe/games",
        json={
            "mode": "online_friend",
            "target_wins": 2,
            "timer_mode": "40s",
            "player1_name": "Host",
            "guest_id": oversized,
        },
    )
    # An oversized/corrupted client id must never 422 and break play.
    assert create.status_code == 200
    game_id = _action_payload(create)["game"]["id"]

    with client.session_local() as db:
        game = db.get(QuizTicTacToeGame, game_id)
        assert game.player1_guest_id == "g" * 64
