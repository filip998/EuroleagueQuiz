from pathlib import Path

import random

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models import Player, PlayerSeasonTeam, Season, Team
from app.models.roster_guess import RosterGuessGame
from app.services import roster_guess
from app.services.realtime_adapters import RosterGuessRealtimeAdapter


@pytest.fixture(autouse=True)
def _seed_random():
    random.seed(42)
    yield
    random.seed()


@pytest.fixture()
def client(tmp_path: Path):
    db_path = tmp_path / "roster_guess_api_test.db"
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


def _create_roster_game(client: TestClient, mode: str = "single_player") -> dict:
    response = client.post(
        "/quiz/roster-guess/games",
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


def test_create_roster_guess_game_returns_state_envelope(client: TestClient):
    game = _create_roster_game(client)

    assert game["mode"] == "single_player"
    assert game["round"]["status"] == "active"
    assert len(game["round"]["slots"]) >= 5


def test_submit_guess_returns_state_envelope_with_result(client: TestClient):
    game = _create_roster_game(client)

    response = client.post(
        f"/quiz/roster-guess/games/{game['id']}/guess",
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
    game = _create_roster_game(client)

    response = client.post(f"/quiz/roster-guess/games/{game['id']}/give-up")

    assert response.status_code == 200
    payload = _action_payload(response)
    assert payload["result"] == "given_up"
    assert payload["completed_round"]["status"] == "given_up"
    assert len(payload["completed_round"]["slots"]) >= 5


def test_online_roster_guess_join_and_missing_player_error_envelope(client: TestClient):
    game = _create_roster_game(client, mode="online_friend")
    assert game["status"] == "waiting_for_opponent"
    assert game["join_code"] is not None

    join = client.post(
        "/quiz/roster-guess/games/join",
        json={"join_code": game["join_code"], "player_name": "Joiner"},
    )
    assert join.status_code == 200
    joined = _action_payload(join)["game"]
    assert joined["id"] == game["id"]
    assert joined["status"] == "active"
    assert joined["round"] is not None

    # Anonymous play persists no guest identity.
    with client.session_local() as db:
        stored = db.get(RosterGuessGame, game["id"])
        assert stored.player1_guest_id is None
        assert stored.player2_guest_id is None

    guess = client.post(
        f"/quiz/roster-guess/games/{joined['id']}/guess",
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


def test_online_roster_guess_persists_guest_id(client: TestClient):
    create = client.post(
        "/quiz/roster-guess/games",
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
        "/quiz/roster-guess/games/join",
        json={
            "join_code": game["join_code"],
            "player_name": "Joiner",
            "guest_id": "joiner-guest-def",
        },
    )
    assert join.status_code == 200

    with client.session_local() as db:
        stored = db.get(RosterGuessGame, game["id"])
        assert stored.player1_guest_id == "host-guest-abc"
        assert stored.player2_guest_id == "joiner-guest-def"


def _create_roster_race_game(client: TestClient, target_wins: int = 3) -> dict:
    response = client.post(
        "/quiz/roster-guess/race/games",
        json={
            "target_wins": target_wins,
            "player1_name": "Racer One",
            "season_range_start": 2024,
            "season_range_end": 2024,
            "guest_id": "race-host",
        },
    )
    assert response.status_code == 200
    return _action_payload(response)["game"]


def _join_roster_race_game(client: TestClient, join_code: str) -> dict:
    response = client.post(
        "/quiz/roster-guess/race/games/join",
        json={
            "join_code": join_code,
            "player_name": "Racer Two",
            "guest_id": "race-joiner",
        },
    )
    assert response.status_code == 200
    return _action_payload(response)["game"]


def _race_guess(
    client: TestClient,
    game_id: int,
    *,
    player_number: int,
    player_id: int,
    round_number: int,
):
    return client.post(
        f"/quiz/roster-guess/games/{game_id}/guess?player={player_number}",
        json={"player_id": player_id, "round_number": round_number},
    )


def test_roster_race_claims_first_guess_and_rejects_duplicate(client: TestClient):
    waiting = _create_roster_race_game(client)
    assert waiting["mode"] == "online_friend"
    assert waiting["game_type"] == "race"
    assert waiting["round_seconds"] == 120
    assert waiting["reveal_seconds"] == 12

    game = _join_roster_race_game(client, waiting["join_code"])
    assert game["status"] == "active"
    assert game["current_round"]["status"] == "active"
    round_number = game["round_number"]

    first = _race_guess(
        client,
        game["id"],
        player_number=1,
        player_id=1,
        round_number=round_number,
    )
    assert first.status_code == 200
    first_payload = _action_payload(first)
    assert first_payload["result"] == "correct"
    assert first_payload["game"]["round"]["player1_correct"] == 1

    duplicate = _race_guess(
        client,
        game["id"],
        player_number=2,
        player_id=1,
        round_number=round_number,
    )
    assert duplicate.status_code == 200
    duplicate_payload = _action_payload(duplicate)
    assert duplicate_payload["result"] == "incorrect"
    assert duplicate_payload["game"]["round"]["player1_correct"] == 1
    assert duplicate_payload["game"]["round"]["player2_correct"] == 0


def test_roster_race_join_code_is_rejected_by_classic_join_endpoint(client: TestClient):
    waiting = _create_roster_race_game(client)

    response = client.post(
        "/quiz/roster-guess/games/join",
        json={
            "join_code": waiting["join_code"],
            "player_name": "Classic Joiner",
            "guest_id": "classic-joiner",
        },
    )

    assert response.status_code == 409
    assert response.json()["payload"]["message"] == "Join code is not for this game type"


def test_roster_race_realtime_adapter_timer_state_uses_race_round_window(client: TestClient):
    waiting = _create_roster_race_game(client)
    game = _join_roster_race_game(client, waiting["join_code"])

    timer_state = RosterGuessRealtimeAdapter().timer_state_from_state(game)

    assert timer_state is not None
    assert timer_state.current_player == 0
    assert timer_state.round_number == game["round_number"]
    assert 0 < timer_state.seconds <= 120


def test_roster_race_tie_round_reveals_and_locks_next_round(client: TestClient):
    waiting = _create_roster_race_game(client, target_wins=3)
    game = _join_roster_race_game(client, waiting["join_code"])
    round_number = game["round_number"]

    # Six seeded roster members; split claims 3-3 to force a tied race round.
    for player_number, player_id in [(1, 1), (2, 2), (1, 3), (2, 4), (1, 5)]:
        response = _race_guess(
            client,
            game["id"],
            player_number=player_number,
            player_id=player_id,
            round_number=round_number,
        )
        assert response.status_code == 200
        assert _action_payload(response)["result"] == "correct"

    final = _race_guess(
        client,
        game["id"],
        player_number=2,
        player_id=6,
        round_number=round_number,
    )
    assert final.status_code == 200
    payload = _action_payload(final)
    assert payload["result"] == "round_complete"
    assert payload["completed_round"]["player1_correct"] == 3
    assert payload["completed_round"]["player2_correct"] == 3
    assert payload["completed_round"]["winner_player"] is None
    assert payload["game"]["player1_score"] == 0
    assert payload["game"]["player2_score"] == 0
    assert payload["game"]["round_number"] == 2
    assert payload["game"]["latest_completed_round"]["next_round_starts_at"] is not None

    locked = _race_guess(
        client,
        game["id"],
        player_number=1,
        player_id=1,
        round_number=2,
    )
    assert locked.status_code == 409
    assert locked.json()["payload"]["message"] == "round_locked"


def test_roster_race_best_of_one_finishes_match(client: TestClient):
    waiting = _create_roster_race_game(client, target_wins=1)
    game = _join_roster_race_game(client, waiting["join_code"])
    round_number = game["round_number"]

    payload = None
    for player_id in range(1, 7):
        response = _race_guess(
            client,
            game["id"],
            player_number=1,
            player_id=player_id,
            round_number=round_number,
        )
        assert response.status_code == 200
        payload = _action_payload(response)

    assert payload["result"] == "match_won"
    assert payload["game"]["status"] == "finished"
    assert payload["game"]["winner_player"] == 1
    assert payload["game"]["player1_score"] == 1


def test_roster_race_timer_expiry_completes_round(client: TestClient):
    waiting = _create_roster_race_game(client, target_wins=3)
    game = _join_roster_race_game(client, waiting["join_code"])
    _race_guess(
        client,
        game["id"],
        player_number=1,
        player_id=1,
        round_number=game["round_number"],
    )

    with client.session_local() as db:
        stored = db.get(RosterGuessGame, game["id"])
        assert roster_guess.handle_race_time_expired(
            db,
            stored,
            expected_round=game["round_number"],
        )
        db.commit()

    state = client.get(f"/quiz/roster-guess/games/{game['id']}")
    assert state.status_code == 200
    data = state.json()
    assert data["round_number"] == 2
    assert data["player1_score"] == 1
    assert data["latest_completed_round"]["winner_player"] == 1


def test_roster_quick_match_public_games_pair_and_hide_join_code(client: TestClient):
    first = client.post(
        "/quiz/roster-guess/quick-match",
        json={
            "preset": "modern-standard",
            "player_name": "Host",
            "guest_id": "quick-host",
        },
    )
    assert first.status_code == 200
    first_game = _action_payload(first)["game"]
    assert first_game["status"] == "waiting_for_opponent"
    assert first_game["is_public"] is True
    assert first_game["preset"] == "modern-standard"
    assert first_game["join_code"] is None

    with client.session_local() as db:
        stored = db.get(RosterGuessGame, first_game["id"])
        public_code = stored.join_code

    direct_join = client.post(
        "/quiz/roster-guess/race/games/join",
        json={
            "join_code": public_code,
            "player_name": "Bypass",
            "guest_id": "bypass-guest",
        },
    )
    assert direct_join.status_code == 409
    assert direct_join.json()["payload"]["message"] == (
        "Public games must be joined through quick match"
    )

    second = client.post(
        "/quiz/roster-guess/quick-match",
        json={
            "preset": "modern-standard",
            "player_name": "Joiner",
            "guest_id": "quick-joiner",
        },
    )
    assert second.status_code == 200
    matched = _action_payload(second)["game"]
    assert matched["id"] == first_game["id"]
    assert matched["status"] == "active"
    assert matched["round"] is not None
    assert matched["round_seconds"] == 120


def test_roster_quick_match_pools_and_cancel(client: TestClient):
    empty = client.get("/quiz/roster-guess/quick-match/pools")
    assert empty.status_code == 200
    assert empty.json()["pools"]["modern-standard"] == {
        "searching": 0,
        "in_progress": 0,
    }

    search = client.post(
        "/quiz/roster-guess/quick-match",
        json={
            "preset": "modern-long",
            "player_name": "Host",
            "guest_id": "pool-host",
        },
    )
    assert search.status_code == 200
    game = _action_payload(search)["game"]

    waiting = client.get("/quiz/roster-guess/quick-match/pools")
    assert waiting.json()["pools"]["modern-long"] == {
        "searching": 1,
        "in_progress": 0,
    }

    cancel = client.post(
        "/quiz/roster-guess/quick-match/cancel",
        json={
            "preset": "modern-long",
            "game_id": game["id"],
            "guest_id": "pool-host",
        },
    )
    assert cancel.status_code == 200
    assert _action_payload(cancel)["game"]["status"] == "cancelled"

    after = client.get("/quiz/roster-guess/quick-match/pools")
    assert after.json()["pools"]["modern-long"] == {
        "searching": 0,
        "in_progress": 0,
    }
