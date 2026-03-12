from pathlib import Path

import pytest
import random
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models import Player, PlayerSeasonTeam, Season, Team


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
        yield test_client

    if previous_override is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous_override
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
    return response.json()


def test_create_tictactoe_game_has_board(client: TestClient):
    payload = _create_ttt_game(client)
    assert payload["mode"] == "local_two_player"
    assert payload["round"]["status"] == "active"
    assert len(payload["round"]["rows"]) == 3
    assert len(payload["round"]["columns"]) == 3
    assert len(payload["round"]["cells"]) == 9


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
    move_1_payload = move_1.json()
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
        move_2_payload = move_2.json()
        assert move_2_payload["result"] == "incorrect"
        assert move_2_payload["game"]["current_player"] == 1

    cell_01_after = _find_cell(move_2_payload["game"], 0, 1)
    assert cell_01_after["claimed_by_player"] is None


def test_draw_offer_accept_starts_new_round(client: TestClient):
    game = _create_ttt_game(client)
    game_id = game["id"]
    starting_round = game["round_number"]

    offer = client.post(f"/quiz/tictactoe/games/{game_id}/draw-offer")
    assert offer.status_code == 200
    offer_payload = offer.json()
    assert offer_payload["result"] == "offered"
    assert offer_payload["game"]["pending_draw"] == {"offered_by": 1, "respond_to": 2}
    assert offer_payload["game"]["current_player"] == 2

    accept = client.post(
        f"/quiz/tictactoe/games/{game_id}/draw-response",
        json={"accept": True},
    )
    assert accept.status_code == 200
    accept_payload = accept.json()
    assert accept_payload["result"] == "accepted"
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
        result = correct_move.json()

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
                assert incorrect_move.json()["result"] == "incorrect"
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
        assert first_move_round_2.json()["result"] == "incorrect"

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
        result = correct_move.json()

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
                assert incorrect_move.json()["result"] == "incorrect"
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
    data = response.json()
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
    joined = response2.json()
    assert joined["game"]["status"] == "active"
    assert joined["game"]["player2_name"] == "Joiner"
    assert joined["game"]["round"] is not None  # board generated

    # Cannot join again
    response3 = client.post(
        "/quiz/tictactoe/games/join",
        json={"join_code": join_code, "player_name": "Late"},
    )
    assert response3.status_code == 409
