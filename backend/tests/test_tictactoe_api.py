from pathlib import Path

import asyncio
import pytest
import random
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models import Player, PlayerSeasonTeam, Season, Team
from app.models.tictactoe import QuizTicTacToeGame
from app.routers import quiz as quiz_router
from app.schemas.realtime import RealtimeServerMessageAdapter
from app.services import matchmaking, tictactoe as ttt_service
from app.services.realtime import DisconnectGraceTimerManager, OnlineGameRealtimeModule
from app.services.realtime_adapters import TicTacToeRealtimeAdapter
from tests.realtime_helpers import FakeWebSocket, SleepController, drain_tasks


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
        test_client.session_local = TestingSessionLocal
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


def test_create_tictactoe_game_has_board(client: TestClient):
    payload = _create_ttt_game(client)
    assert payload["mode"] == "local_two_player"
    assert payload["is_public"] is False
    assert payload["preset"] is None
    assert payload["round"]["status"] == "active"
    assert len(payload["round"]["rows"]) == 3
    assert len(payload["round"]["columns"]) == 3
    assert len(payload["round"]["cells"]) == 9


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
