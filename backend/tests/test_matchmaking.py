import asyncio
from pathlib import Path

import pytest
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.game_actions import InvalidGameActionError
from app.models import (
    Player,
    PlayerSeasonTeam,
    QuizTicTacToeGame,
    QuizTicTacToeRound,
    Season,
    Team,
)
from app.services import matchmaking, tictactoe
from app.services.matchmaking import (
    MatchmakingCancelRequest,
    MatchmakingRequest,
    MatchmakingStatus,
    cancel_search,
    find_or_create_match,
)
from app.services.matchmaking_adapters import TicTacToeMatchmakingAdapter


@pytest.fixture()
def session_factory(tmp_path: Path):
    db_path = tmp_path / "matchmaking_test.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=engine,
        expire_on_commit=False,
    )
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        _seed_tictactoe_board_data(session)
        session.commit()
    finally:
        session.close()

    yield TestingSessionLocal
    engine.dispose()


def test_find_or_create_pairs_two_tictactoe_requests(session_factory):
    adapter = TicTacToeMatchmakingAdapter()
    with session_factory() as db:
        first = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Host",
                    guest_id="host-guest",
                ),
            )
        )
        assert first.status == MatchmakingStatus.SEARCHING
        assert first.player == 1
        assert first.game.status == "waiting_for_opponent"
        assert first.game.is_public is True
        assert first.game.preset == "standard"

        second = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Joiner",
                    guest_id="joiner-guest",
                ),
            )
        )

        assert second.status == MatchmakingStatus.MATCHED
        assert second.player == 2
        assert second.game.id == first.game.id
        assert second.game.status == "active"
        assert second.game.player2_guest_id == "joiner-guest"
        assert second.game.round_number == 1


def test_matched_guest_retry_returns_active_game(session_factory):
    adapter = TicTacToeMatchmakingAdapter()
    with session_factory() as db:
        host = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Host",
                    guest_id="host-guest",
                ),
            )
        )
        joiner = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Joiner",
                    guest_id="joiner-guest",
                ),
            )
        )
        host_retry = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Host Retry",
                    guest_id="host-guest",
                ),
            )
        )
        joiner_retry = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Joiner Retry",
                    guest_id="joiner-guest",
                ),
            )
        )

        assert host.status == MatchmakingStatus.SEARCHING
        assert joiner.status == MatchmakingStatus.MATCHED
        assert host_retry.status == MatchmakingStatus.MATCHED
        assert host_retry.player == 1
        assert host_retry.game.id == joiner.game.id
        assert joiner_retry.status == MatchmakingStatus.MATCHED
        assert joiner_retry.player == 2
        assert joiner_retry.game.id == joiner.game.id
        assert db.query(QuizTicTacToeGame).count() == 1


def test_tictactoe_matchmaking_ignores_friend_games(session_factory):
    adapter = TicTacToeMatchmakingAdapter()
    with session_factory() as db:
        friend_game = tictactoe.create_game(
            db,
            mode="online_friend",
            target_wins=2,
            timer_mode="40s",
            player1_name="Friend",
            guest_id="friend-guest",
        )
        friend_game.preset = "standard"
        db.commit()

        result = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Searcher",
                    guest_id="searcher-guest",
                ),
            )
        )

        assert result.status == MatchmakingStatus.SEARCHING
        assert result.game.id != friend_game.id
        assert friend_game.is_public is False


def test_tictactoe_matchmaking_is_idempotent_for_same_guest(session_factory):
    adapter = TicTacToeMatchmakingAdapter()
    with session_factory() as db:
        first = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="First",
                    guest_id="same-guest",
                ),
            )
        )
        second = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Second",
                    guest_id="same-guest",
                ),
            )
        )
        assert first.status == MatchmakingStatus.SEARCHING
        assert second.status == MatchmakingStatus.SEARCHING
        assert second.game.id == first.game.id

        third = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Third",
                    guest_id="other-guest",
                ),
            )
        )

        assert third.status == MatchmakingStatus.MATCHED
        assert third.game.id == first.game.id
        remaining_waiting = (
            db.query(QuizTicTacToeGame)
            .filter(
                QuizTicTacToeGame.status == "waiting_for_opponent",
                QuizTicTacToeGame.is_public.is_(True),
            )
            .all()
        )
        assert remaining_waiting == []


def test_find_or_create_requires_guest_id(session_factory):
    adapter = TicTacToeMatchmakingAdapter()
    with session_factory() as db:
        with pytest.raises(InvalidGameActionError, match="guest_id is required"):
            asyncio.run(
                find_or_create_match(
                    db,
                    adapter,
                    MatchmakingRequest(preset="standard", player_name="Anonymous"),
                )
            )


def test_tictactoe_matchmaking_randomizes_first_move(session_factory, monkeypatch):
    adapter = TicTacToeMatchmakingAdapter()
    monkeypatch.setattr(matchmaking, "random_starting_player", lambda: 2)

    with session_factory() as db:
        first = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Host",
                    guest_id="host-guest",
                ),
            )
        )
        second = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Joiner",
                    guest_id="joiner-guest",
                ),
            )
        )

        round_obj = (
            db.query(QuizTicTacToeRound)
            .filter(QuizTicTacToeRound.game_id == first.game.id)
            .one()
        )
        assert second.status == MatchmakingStatus.MATCHED
        assert second.starting_player == 2
        assert second.game.current_player == 2
        assert round_obj.started_by_player == 2


def test_cancel_search_removes_waiting_public_game_and_frees_pool(session_factory):
    adapter = TicTacToeMatchmakingAdapter()
    with session_factory() as db:
        search = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Host",
                    guest_id="host-guest",
                ),
            )
        )
        cancelled = asyncio.run(
            cancel_search(
                db,
                adapter,
                MatchmakingCancelRequest(
                    preset="standard",
                    game_id=search.game.id,
                    guest_id="host-guest",
                ),
            )
        )
        cancelled_game_id = search.game.id

        assert cancelled.status == MatchmakingStatus.CANCELLED

    with session_factory() as db:
        assert db.get(QuizTicTacToeGame, cancelled_game_id) is None

    with session_factory() as db:
        next_search = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Next",
                    guest_id="next-guest",
                ),
            )
        )

        assert next_search.status == MatchmakingStatus.SEARCHING


def test_cancel_search_requires_guest_id(session_factory):
    adapter = TicTacToeMatchmakingAdapter()
    with session_factory() as db:
        search = asyncio.run(
            find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name="Host",
                    guest_id="host-guest",
                ),
            )
        )

        with pytest.raises(InvalidGameActionError, match="guest_id is required"):
            asyncio.run(
                cancel_search(
                    db,
                    adapter,
                    MatchmakingCancelRequest(
                        preset="standard",
                        game_id=search.game.id,
                    ),
                )
            )


def test_two_simultaneous_requests_to_empty_pool_create_exactly_one_match(
    session_factory,
    monkeypatch,
):
    adapter = TicTacToeMatchmakingAdapter()

    async def yield_after_find():
        await asyncio.sleep(0)

    monkeypatch.setattr(matchmaking, "_after_find_hook", yield_after_find)

    async def request(player_name: str, guest_id: str):
        db = session_factory()
        try:
            return await find_or_create_match(
                db,
                adapter,
                MatchmakingRequest(
                    preset="standard",
                    player_name=player_name,
                    guest_id=guest_id,
                ),
            )
        finally:
            db.close()

    async def run_requests():
        return await asyncio.gather(
            request("Player A", "guest-a"),
            request("Player B", "guest-b"),
        )

    first, second = asyncio.run(run_requests())

    assert {first.status, second.status} == {
        MatchmakingStatus.SEARCHING,
        MatchmakingStatus.MATCHED,
    }
    assert first.game.id == second.game.id
    assert {first.player, second.player} == {1, 2}

    with session_factory() as db:
        games = db.query(QuizTicTacToeGame).all()
        assert len(games) == 1
        assert games[0].status == "active"
        assert games[0].is_public is True
        waiting_count = (
            db.query(func.count(QuizTicTacToeGame.id))
            .filter(QuizTicTacToeGame.status == "waiting_for_opponent")
            .scalar()
        )
        assert waiting_count == 0


def _seed_tictactoe_board_data(db):
    season = Season(year=2024, name="2024-2025")
    teams = [
        Team(euroleague_code=f"T{index}", name=f"Team {index}")
        for index in range(1, 7)
    ]
    players = [
        Player(
            euroleague_code=f"P{index}",
            first_name=f"Player{index}",
            last_name="Test",
            nationality="CountryA",
        )
        for index in range(1, 6)
    ]
    db.add(season)
    db.add_all(teams)
    db.add_all(players)
    db.flush()

    for player in players:
        for team in teams:
            db.add(
                PlayerSeasonTeam(
                    player_id=player.id,
                    team_id=team.id,
                    season_id=season.id,
                )
            )
