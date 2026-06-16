from pathlib import Path

import random

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models import Player, PlayerSeasonTeam, Season, Team


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
