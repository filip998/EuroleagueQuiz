import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.database import Base, get_db

# Use in-memory SQLite for tests
TEST_DATABASE_URL = "sqlite:///data/euroleague.db"  # Use real DB for now since it has data

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


def test_root():
    r = client.get("/")
    assert r.status_code == 200


def test_list_seasons():
    r = client.get("/seasons/")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)


def test_get_season():
    r = client.get("/seasons/2023")
    assert r.status_code == 200
    data = r.json()
    assert data["year"] == 2023


def test_list_teams():
    r = client.get("/teams/")
    assert r.status_code == 200


def test_get_team():
    r = client.get("/teams/BAR")
    assert r.status_code == 200
    assert "BAR" in r.json()["euroleague_code"]


def test_list_players():
    r = client.get("/players/?limit=5")
    assert r.status_code == 200
    assert len(r.json()) <= 5


def test_get_player():
    r = client.get("/players/1")
    assert r.status_code == 200


def test_list_games():
    r = client.get("/games/?limit=5")
    assert r.status_code == 200
    assert len(r.json()) <= 5


def test_get_game():
    r = client.get("/games/1")
    assert r.status_code == 200


def test_404_nonexistent():
    r = client.get("/seasons/1900")
    assert r.status_code == 404
    r2 = client.get("/teams/NONEXIST")
    assert r2.status_code == 404
