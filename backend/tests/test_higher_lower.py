"""Tests for the Higher or Lower game API."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app

TEST_DATABASE_URL = "sqlite:///data/euroleague.db"
engine = create_engine(TEST_DATABASE_URL, connect_args={"check_same_thread": False})
TestSession = sessionmaker(bind=engine)


def override_get_db():
    db = TestSession()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db
client = TestClient(app)


def _create_game(tier="easy"):
    resp = client.post("/quiz/higher-lower/games", json={
        "tier": tier,
        "season_range_start": 2003,
        "season_range_end": 2025,
        "nickname": "TestPlayer",
    })
    assert resp.status_code == 200
    return resp.json()


def test_create_game():
    data = _create_game()
    assert "game_id" in data
    assert "pair" in data
    pair = data["pair"]
    assert "left" in pair and "right" in pair
    assert pair["left"]["name"]
    assert pair["right"]["name"]
    assert pair["category"]
    assert pair["category_label"]


def test_create_game_all_tiers():
    for tier in ("easy", "medium", "hard"):
        data = _create_game(tier=tier)
        assert data["game_id"] > 0


def test_answer_flow():
    data = _create_game()
    game_id = data["game_id"]
    pair = data["pair"]

    # We don't know the correct answer, but we can try all three options
    # and verify the response structure
    for choice in ("left", "right", "same"):
        resp = client.post(f"/quiz/higher-lower/games/{game_id}/answer", json={"choice": choice})
        assert resp.status_code == 200
        result = resp.json()
        assert "correct" in result
        assert "left_value" in result
        assert "right_value" in result
        assert "streak" in result

        if result["correct"]:
            assert result["next_pair"] is not None
            assert result["streak"] >= 1
        else:
            assert result["next_pair"] is None
            assert result["is_personal_best"] is not None
            assert result["leaderboard_position"] is not None
        break  # Only submit one answer per game


def test_finished_game_rejects_answers():
    data = _create_game()
    game_id = data["game_id"]

    # Submit wrong answers until game ends
    for _ in range(100):
        resp = client.post(f"/quiz/higher-lower/games/{game_id}/answer", json={"choice": "left"})
        result = resp.json()
        if not result["correct"]:
            break

    # Try answering again — should fail
    resp = client.post(f"/quiz/higher-lower/games/{game_id}/answer", json={"choice": "left"})
    assert resp.status_code == 400


def test_leaderboard():
    # Create and finish a game to have at least one score
    data = _create_game()
    game_id = data["game_id"]
    for _ in range(100):
        resp = client.post(f"/quiz/higher-lower/games/{game_id}/answer", json={"choice": "left"})
        if not resp.json()["correct"]:
            break

    resp = client.get("/quiz/higher-lower/leaderboard/easy")
    assert resp.status_code == 200
    lb = resp.json()
    assert lb["tier"] == "easy"
    assert isinstance(lb["entries"], list)
    if len(lb["entries"]) > 0:
        entry = lb["entries"][0]
        assert "nickname" in entry
        assert "streak" in entry


def test_invalid_tier_leaderboard():
    resp = client.get("/quiz/higher-lower/leaderboard/invalid")
    assert resp.status_code == 400


def test_invalid_season_range():
    resp = client.post("/quiz/higher-lower/games", json={
        "tier": "easy",
        "season_range_start": 2025,
        "season_range_end": 2003,
        "nickname": "Test",
    })
    assert resp.status_code == 400
