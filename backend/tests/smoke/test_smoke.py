"""
Smoke tests — verify critical API endpoints return 200 on a live deployment.
"""

import pytest


class TestHealthEndpoints:
    def test_root(self, client):
        r = client.get("/")
        assert r.status_code == 200
        data = r.json()
        assert "message" in data

    def test_docs_accessible(self, client):
        r = client.get("/docs")
        assert r.status_code == 200


class TestDataEndpoints:
    def test_seasons_list(self, client):
        r = client.get("/seasons/")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) > 0

    def test_teams_list(self, client):
        r = client.get("/teams/")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) > 0

    def test_players_list(self, client):
        r = client.get("/players/?limit=5")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)

    def test_games_list(self, client):
        r = client.get("/games/?limit=5")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)


class TestQuizEndpoints:
    def test_random_player(self, client):
        r = client.get("/quiz/random-player")
        assert r.status_code == 200
        data = r.json()
        assert "first_name" in data or "id" in data

    def test_higher_lower_leaderboard(self, client):
        r = client.get("/quiz/higher-lower/leaderboard/easy")
        assert r.status_code == 200

    def test_tictactoe_autocomplete(self, client):
        r = client.get("/quiz/tictactoe/players/autocomplete?q=luka&limit=5")
        assert r.status_code == 200
        data = r.json()
        assert "players" in data

    def test_roster_autocomplete(self, client):
        r = client.get("/quiz/roster-guess/players/autocomplete?q=doncic&limit=5")
        assert r.status_code == 200
        data = r.json()
        assert "players" in data


class TestGameCreation:
    def test_create_higher_lower_game(self, client):
        r = client.post(
            "/quiz/higher-lower/games",
            json={
                "tier": "easy",
                "nickname": "smoke-test",
                "season_range_start": 2020,
                "season_range_end": 2025,
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert "game_id" in data

    def test_create_tictactoe_game(self, client):
        r = client.post(
            "/quiz/tictactoe/games",
            json={"mode": "single_player"},
        )
        assert r.status_code == 200
