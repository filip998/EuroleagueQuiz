from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.game_actions import ConflictGameActionError
from app.main import app
from app.models import (
    CareerDataRevision,
    CareerQuizGame,
    Player,
    PlayerCareerSourceMapping,
    PlayerCareerStint,
)
from app.services import career_quiz
from app.services.realtime_adapters import CareerQuizRealtimeAdapter
from app.services.solo_round_token import create_solo_round_token


def test_format_years_uses_wikipedia_calendar_style():
    from types import SimpleNamespace

    def years(raw_start, raw_end, is_current, start_year=None):
        stint = SimpleNamespace(
            raw_start=raw_start,
            raw_end=raw_end,
            is_current=is_current,
            start_season_year=start_year,
        )
        return career_quiz._format_years(stint)

    assert years("1999", "2004", False) == "1999\u20132004"
    assert years("2010", "2010", False) == "2010"
    assert years("2024", None, True) == "2024\u2013present"
    assert years(None, None, False, start_year=2015) == "2015\u2013present"


def test_solo_round_guess_and_reveal():
    db = _session()
    try:
        answer = _eligible_player(db, "Nikos", "Zisis")
        other = _eligible_player(db, "Other", "Player")
        _active_revision(db)

        round_data = career_quiz.create_solo_round(db, recent_player_ids=[other.id])
        assert len(round_data["timeline"]) == 3

        guess = career_quiz.submit_solo_guess(
            db,
            round_token=round_data["round_token"],
            player_id=other.id,
        )
        assert guess == {"correct": False}

        reveal = career_quiz.reveal_solo_answer(db, round_token=round_data["round_token"])
        assert reveal["answer"]["id"] in {answer.id, other.id}
    finally:
        db.close()


def test_solo_hints_progress_through_metadata_skeleton_and_letters():
    db = _session()
    try:
        answer = _eligible_player(db, "Nikos", "Zisis")
        answer.nationality = "Serbia"
        answer.position = "Guard"
        _active_revision(db)
        token = _solo_token(answer)

        nationality = career_quiz.get_solo_hint(
            db, round_token=token, shown_hints=[], revealed_letters=[]
        )
        assert nationality["type"] == "nationality"
        assert nationality["nationality"] == "Serbia"
        assert "Nikos" not in repr(nationality)
        assert "Zisis" not in repr(nationality)

        position = career_quiz.get_solo_hint(
            db,
            round_token=token,
            shown_hints=["nationality"],
            revealed_letters=[],
        )
        assert position == {"type": "position", "position": "Guard"}

        skeleton = career_quiz.get_solo_hint(
            db,
            round_token=token,
            shown_hints=["nationality", "position"],
            revealed_letters=[],
        )
        assert skeleton["type"] == "name_skeleton"
        assert "Nikos" not in repr(skeleton)
        assert "Zisis" not in repr(skeleton)
        assert "first_name" not in skeleton
        assert "last_name" not in skeleton
        hidden_tokens = [
            token for token in skeleton["skeleton"] if token["kind"] == "hidden_letter"
        ]
        assert len(hidden_tokens) == len("NikosZisis")
        assert any(token == {"kind": "space", "index": 5, "value": " "} for token in skeleton["skeleton"])

        reveal = career_quiz.get_solo_hint(
            db,
            round_token=token,
            shown_hints=["nationality", "position", "name_skeleton"],
            revealed_letters=[],
        )
        assert reveal["type"] == "letter_reveal"
        expected_positions = [
            index
            for index, character in enumerate("Nikos Zisis")
            if character.isalpha() and character.casefold() == reveal["letter"]
        ]
        assert reveal["positions"] == expected_positions
        assert "Nikos Zisis" not in repr(reveal)
    finally:
        db.close()


def test_solo_letter_hints_always_leave_one_distinct_letter_hidden():
    db = _session()
    try:
        answer = _eligible_player(db, "Aa", "Bb")
        _active_revision(db)
        token = _solo_token(answer)

        reveal = career_quiz.get_solo_hint(
            db,
            round_token=token,
            shown_hints=["nationality", "position", "name_skeleton"],
            revealed_letters=[],
        )

        assert reveal["type"] == "letter_reveal"
        assert reveal["letter"] in {"a", "b"}
        assert reveal["positions"] in ([0, 1], [3, 4])

        distinct_letters = set(career_quiz._solo_letter_positions_by_key(answer))
        reserved = career_quiz._reserved_solo_hint_letter(answer, distinct_letters)
        assert reveal["letter"] != reserved

        exhausted = career_quiz.get_solo_hint(
            db,
            round_token=token,
            shown_hints=["nationality", "position", "name_skeleton"],
            revealed_letters=[reveal["letter"]],
        )
        assert exhausted == {"type": "exhausted"}
    finally:
        db.close()


def test_solo_letter_hints_are_exhausted_for_single_distinct_letter_name():
    db = _session()
    try:
        answer = _eligible_player(db, "Aaa", "Aa")
        _active_revision(db)
        token = _solo_token(answer)

        hint = career_quiz.get_solo_hint(
            db,
            round_token=token,
            shown_hints=["nationality", "position", "name_skeleton"],
            revealed_letters=[],
        )

        assert hint == {"type": "exhausted"}
    finally:
        db.close()


def test_solo_letter_hints_never_return_reserved_letter_with_stale_progress():
    db = _session()
    try:
        answer = _eligible_player(db, "Alpha", "Beta")
        _active_revision(db)
        token = _solo_token(answer)
        distinct_letters = set(career_quiz._solo_letter_positions_by_key(answer))
        reserved = career_quiz._reserved_solo_hint_letter(answer, distinct_letters)

        seen = set()
        for _ in range(40):
            hint = career_quiz.get_solo_hint(
                db,
                round_token=token,
                shown_hints=["nationality", "position", "name_skeleton"],
                revealed_letters=[],
            )
            assert hint["type"] == "letter_reveal"
            assert hint["letter"] != reserved
            seen.add(hint["letter"])

        assert reserved not in seen
        assert distinct_letters - seen
    finally:
        db.close()


def test_solo_name_skeleton_preserves_punctuation_and_folds_accents():
    db = _session()
    try:
        answer = _eligible_player(db, "Ćać", "Melli-Jones")

        skeleton = career_quiz._solo_name_skeleton(answer)
        positions = career_quiz._solo_letter_positions_by_key(answer)

        assert any(
            token == {"kind": "punctuation", "index": 9, "value": "-"}
            for token in skeleton
        )
        assert positions["c"] == [0, 2]
    finally:
        db.close()


def test_autocomplete_uses_only_eligible_career_players():
    db = _session()
    try:
        eligible = _eligible_player(db, "Milos", "Teodosic")
        ineligible = Player(euroleague_code="PINELIG", first_name="Milos", last_name="Missing")
        db.add(ineligible)
        _active_revision(db)
        db.commit()

        players = career_quiz.autocomplete_players(db, q="milos")

        assert [player["id"] for player in players] == [eligible.id]
    finally:
        db.close()


def test_multiplayer_first_correct_answer_wins_match_when_target_is_one():
    db = _session()
    try:
        answer = _eligible_player(db, "Saras", "Jasikevicius")
        wrong = _eligible_player(db, "Wrong", "Guess")
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(db, target_wins=1, player1_name="A")
        career_quiz.join_game(db, game.join_code, player_name="B")
        current = game.rounds[0]
        wrong_id = wrong.id if current.answer_player_id == answer.id else answer.id

        result = career_quiz.submit_guess(
            db,
            game=game,
            player_id=wrong_id,
            acting_player=2,
            round_number=current.round_number,
        )
        assert result == "incorrect"

        result = career_quiz.submit_guess(
            db,
            game=game,
            player_id=current.answer_player_id,
            acting_player=1,
            round_number=current.round_number,
        )

        assert result == "match_won"
        assert game.status == "finished"
        assert game.winner_player == 1
        assert career_quiz.serialize_completed_round(db, game.id, 1)["answer"]["id"] == current.answer_player_id
    finally:
        db.close()


def test_multiplayer_shared_wrong_guesses_are_serialized_on_current_round():
    db = _session()
    try:
        players = [
            _eligible_player(db, "Shared", "Answer"),
            _eligible_player(db, "Shared", "WrongOne"),
            _eligible_player(db, "Shared", "WrongTwo"),
        ]
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(
            db,
            target_wins=3,
            wrong_guess_visibility="shared",
            player1_name="A",
        )
        career_quiz.join_game(db, game.join_code, player_name="B")
        current = career_quiz._current_round(game)
        wrong_players = [
            player for player in players if player.id != current.answer_player_id
        ][:2]

        assert career_quiz.submit_guess(
            db,
            game=game,
            player_id=wrong_players[0].id,
            acting_player=1,
            round_number=current.round_number,
        ) == "incorrect"
        assert career_quiz.submit_guess(
            db,
            game=game,
            player_id=wrong_players[1].id,
            acting_player=2,
            round_number=current.round_number,
        ) == "incorrect"

        current_round = career_quiz.serialize_game_state(db, game)["current_round"]

        assert current_round["round_number"] == current.round_number
        assert current_round["wrong_guesses"] == [
            {
                "player_number": 1,
                "player": {
                    "id": wrong_players[0].id,
                    "name": f"{wrong_players[0].first_name} {wrong_players[0].last_name}",
                    "image_url": None,
                },
            },
            {
                "player_number": 2,
                "player": {
                    "id": wrong_players[1].id,
                    "name": f"{wrong_players[1].first_name} {wrong_players[1].last_name}",
                    "image_url": None,
                },
            },
        ]
    finally:
        db.close()


def test_multiplayer_private_wrong_guesses_are_not_serialized():
    db = _session()
    try:
        players = [
            _eligible_player(db, "Private", "Answer"),
            _eligible_player(db, "Private", "Wrong"),
        ]
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(
            db,
            target_wins=3,
            wrong_guess_visibility="private",
            player1_name="A",
        )
        career_quiz.join_game(db, game.join_code, player_name="B")
        current = career_quiz._current_round(game)
        wrong_player = next(
            player for player in players if player.id != current.answer_player_id
        )

        assert career_quiz.submit_guess(
            db,
            game=game,
            player_id=wrong_player.id,
            acting_player=2,
            round_number=current.round_number,
        ) == "incorrect"

        current_round = career_quiz.serialize_game_state(db, game)["current_round"]

        assert "wrong_guesses" not in current_round
        assert f"{wrong_player.first_name} {wrong_player.last_name}" not in repr(
            current_round
        )
    finally:
        db.close()


def test_realtime_adapter_targets_private_wrong_guess_to_actor_only():
    db = _session()
    try:
        players = [
            _eligible_player(db, "Private", "RealtimeAnswer"),
            _eligible_player(db, "Private", "RealtimeWrong"),
        ]
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(
            db,
            target_wins=3,
            wrong_guess_visibility="private",
            player1_name="A",
        )
        career_quiz.join_game(db, game.join_code, player_name="B")
        current = career_quiz._current_round(game)
        wrong_player = next(
            player for player in players if player.id != current.answer_player_id
        )

        outcome = CareerQuizRealtimeAdapter().handle_client_action(
            db,
            game,
            action="guess",
            data={"player_id": wrong_player.id, "round_number": current.round_number},
            player=1,
        )

        assert outcome.result == "incorrect"
        assert outcome.broadcast_to_player == 1
        assert outcome.completed_round_number is None
    finally:
        db.close()


def test_realtime_adapter_broadcasts_shared_wrong_guess_to_both_players():
    db = _session()
    try:
        players = [
            _eligible_player(db, "Shared", "RealtimeAnswer"),
            _eligible_player(db, "Shared", "RealtimeWrong"),
        ]
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(
            db,
            target_wins=3,
            wrong_guess_visibility="shared",
            player1_name="A",
        )
        career_quiz.join_game(db, game.join_code, player_name="B")
        current = career_quiz._current_round(game)
        wrong_player = next(
            player for player in players if player.id != current.answer_player_id
        )

        outcome = CareerQuizRealtimeAdapter().handle_client_action(
            db,
            game,
            action="guess",
            data={"player_id": wrong_player.id, "round_number": current.round_number},
            player=1,
        )

        assert outcome.result == "incorrect"
        assert outcome.broadcast_to_player is None
    finally:
        db.close()


def test_multiplayer_state_exposes_latest_completed_round_after_no_answer_accept():
    db = _session()
    try:
        _eligible_player(db, "Answer", "Player")
        _eligible_player(db, "Next", "Player")
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(db, target_wins=3, player1_name="A")
        career_quiz.join_game(db, game.join_code, player_name="B")
        current = game.rounds[0]

        state = career_quiz.serialize_game_state(db, game)
        assert state["latest_completed_round"] is None

        career_quiz.offer_no_answer(
            db,
            game=game,
            acting_player=1,
            round_number=current.round_number,
        )
        result = career_quiz.respond_no_answer(
            db,
            game=game,
            acting_player=2,
            accept=True,
            round_number=current.round_number,
        )

        assert result == "accepted"
        completed = career_quiz.serialize_game_state(db, game)["latest_completed_round"]
        assert completed["round_number"] == 1
        assert completed["status"] == "no_answer"
        assert completed["winner_player"] is None
        assert completed["answer"]["id"] == current.answer_player_id
        _assert_player_answer_payload(completed["answer"])
        _assert_iso_datetime(completed["resolved_at"])
        _assert_next_round_starts_at(
            completed["resolved_at"], completed["next_round_starts_at"]
        )
    finally:
        db.close()


def test_multiplayer_state_exposes_latest_completed_round_after_correct_guess():
    db = _session()
    try:
        _eligible_player(db, "Correct", "Answer")
        _eligible_player(db, "Future", "Round")
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(db, target_wins=3, player1_name="A")
        career_quiz.join_game(db, game.join_code, player_name="B")
        current = game.rounds[0]

        result = career_quiz.submit_guess(
            db,
            game=game,
            player_id=current.answer_player_id,
            acting_player=1,
            round_number=current.round_number,
        )

        assert result == "round_won"
        completed = career_quiz.serialize_game_state(db, game)["latest_completed_round"]
        assert completed["round_number"] == 1
        assert completed["status"] == "completed"
        assert completed["winner_player"] == 1
        assert completed["answer"]["id"] == current.answer_player_id
        _assert_player_answer_payload(completed["answer"])
        _assert_iso_datetime(completed["resolved_at"])
        _assert_next_round_starts_at(
            completed["resolved_at"], completed["next_round_starts_at"]
        )
    finally:
        db.close()


def test_multiplayer_rejects_guess_during_reveal_lock_then_accepts_after_countdown():
    db = _session()
    try:
        _eligible_player(db, "First", "Answer")
        _eligible_player(db, "Second", "Answer")
        _eligible_player(db, "Third", "Answer")
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(db, target_wins=3, player1_name="A")
        career_quiz.join_game(db, game.join_code, player_name="B")
        completed_round = career_quiz._current_round(game)

        result = career_quiz.submit_guess(
            db,
            game=game,
            player_id=completed_round.answer_player_id,
            acting_player=1,
            round_number=completed_round.round_number,
        )

        assert result == "round_won"
        locked_round = career_quiz._current_round(game)
        with pytest.raises(ConflictGameActionError, match="round_locked"):
            career_quiz.submit_guess(
                db,
                game=game,
                player_id=locked_round.answer_player_id,
                acting_player=2,
                round_number=locked_round.round_number,
            )

        completed_round.completed_at = datetime.utcnow() - timedelta(
            seconds=career_quiz.CAREER_REVEAL_COUNTDOWN_SECONDS + 1
        )
        db.flush()
        assert (
            career_quiz.serialize_game_state(db, game)["latest_completed_round"][
                "next_round_starts_at"
            ]
            is None
        )

        result = career_quiz.submit_guess(
            db,
            game=game,
            player_id=locked_round.answer_player_id,
            acting_player=2,
            round_number=locked_round.round_number,
        )

        assert result == "round_won"
    finally:
        db.close()


def test_multiplayer_no_answer_accept_locks_next_round_guesses():
    db = _session()
    try:
        _eligible_player(db, "No", "Answer")
        _eligible_player(db, "Locked", "Round")
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(db, target_wins=3, player1_name="A")
        career_quiz.join_game(db, game.join_code, player_name="B")

        current = career_quiz._current_round(game)
        career_quiz.offer_no_answer(
            db,
            game=game,
            acting_player=1,
            round_number=current.round_number,
        )
        result = career_quiz.respond_no_answer(
            db,
            game=game,
            acting_player=2,
            accept=True,
            round_number=current.round_number,
        )

        assert result == "accepted"
        locked_round = career_quiz._current_round(game)
        with pytest.raises(ConflictGameActionError, match="round_locked"):
            career_quiz.submit_guess(
                db,
                game=game,
                player_id=locked_round.answer_player_id,
                acting_player=1,
                round_number=locked_round.round_number,
            )
    finally:
        db.close()


def test_multiplayer_rejects_stale_round_scoped_actions():
    db = _session()
    try:
        _eligible_player(db, "Stale", "First")
        _eligible_player(db, "Stale", "Second")
        _eligible_player(db, "Stale", "Third")
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(db, target_wins=3, player1_name="A")
        career_quiz.join_game(db, game.join_code, player_name="B")
        completed_round = career_quiz._current_round(game)
        result = career_quiz.submit_guess(
            db,
            game=game,
            player_id=completed_round.answer_player_id,
            acting_player=1,
            round_number=completed_round.round_number,
        )
        assert result == "round_won"
        completed_round.completed_at = datetime.utcnow() - timedelta(
            seconds=career_quiz.CAREER_REVEAL_COUNTDOWN_SECONDS + 1
        )
        current_round = career_quiz._current_round(game)

        with pytest.raises(ConflictGameActionError, match="round_stale"):
            career_quiz.submit_guess(
                db,
                game=game,
                player_id=current_round.answer_player_id,
                acting_player=2,
                round_number=completed_round.round_number,
            )

        with pytest.raises(ConflictGameActionError, match="round_stale"):
            career_quiz.offer_no_answer(
                db,
                game=game,
                acting_player=2,
                round_number=completed_round.round_number,
            )

        with pytest.raises(ConflictGameActionError, match="round_stale"):
            career_quiz.respond_no_answer(
                db,
                game=game,
                acting_player=2,
                accept=True,
                round_number=completed_round.round_number,
            )
    finally:
        db.close()


def test_low_threshold_revision_does_not_enable_quiz():
    db = _session()
    try:
        _eligible_player(db, "Low", "Threshold")
        revision = CareerDataRevision(
            revision="low-threshold",
            status="active",
            eligible_player_count=20,
            threshold_player_count=20,
            threshold_passed=True,
            is_active=True,
        )
        db.add(revision)
        db.commit()

        with pytest.raises(ConflictGameActionError, match="Career Quiz is not enabled"):
            career_quiz.create_solo_round(db, recent_player_ids=[])
    finally:
        db.close()


def _session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _active_revision(db):
    revision = CareerDataRevision(
        revision="test-revision",
        status="active",
        eligible_player_count=200,
        threshold_player_count=200,
        threshold_passed=True,
        is_active=True,
    )
    db.add(revision)
    return revision


def _solo_token(player):
    return create_solo_round_token(
        player_id=player.id,
        data_revision="test-revision",
    )


def _eligible_player(db, first_name: str, last_name: str):
    player = Player(
        euroleague_code=f"P{first_name}{last_name}",
        first_name=first_name,
        last_name=last_name,
    )
    db.add(player)
    db.flush()
    mapping = PlayerCareerSourceMapping(
        player_id=player.id,
        source_name="wikipedia",
        source_player_key=f"wiki:{player.id}",
        source_player_label=f"{first_name} {last_name}",
        source_player_url=f"https://en.wikipedia.org/wiki/{first_name}_{last_name}",
        status="accepted",
        candidate_count=1,
    )
    db.add(mapping)
    db.flush()
    for index in range(3):
        db.add(
            PlayerCareerStint(
                mapping_id=mapping.id,
                player_id=player.id,
                sequence_index=index + 1,
                source_name="wikipedia",
                source_player_key=mapping.source_player_key,
                source_team_key=f"T{player.id}{index}",
                source_team_label=f"Team {index}",
                start_season=f"200{index}/0{index + 1}",
                start_season_year=2000 + index,
                include_in_quiz=True,
            )
        )
    db.flush()
    return player


def _assert_player_answer_payload(answer):
    assert {
        "id",
        "name",
        "first_name",
        "last_name",
        "nationality",
        "position",
        "image_url",
    }.issubset(answer)


def _assert_iso_datetime(value):
    assert value
    resolved_at = datetime.fromisoformat(value)
    assert resolved_at.tzinfo is not None
    assert resolved_at.utcoffset() == timedelta(0)
    assert resolved_at.tzinfo == timezone.utc


def _assert_next_round_starts_at(resolved_at_value, next_round_starts_at_value):
    assert next_round_starts_at_value.endswith("+00:00")
    _assert_iso_datetime(next_round_starts_at_value)
    resolved_at = datetime.fromisoformat(resolved_at_value)
    next_round_starts_at = datetime.fromisoformat(next_round_starts_at_value)
    assert next_round_starts_at - resolved_at == timedelta(
        seconds=career_quiz.CAREER_REVEAL_COUNTDOWN_SECONDS
    )


@pytest.fixture()
def career_client(tmp_path: Path):
    db_path = tmp_path / "career_api_test.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        _active_revision(session)
        for index in range(5):
            _eligible_player(session, f"First{index}", f"Last{index}")
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


def test_career_http_create_and_join_persists_guest_id(career_client: TestClient):
    create = career_client.post(
        "/quiz/career/games",
        json={"target_wins": 1, "player1_name": "Host", "guest_id": "host-guest-xyz"},
    )
    assert create.status_code == 200
    game = create.json()["payload"]["game"]
    assert game["status"] == "waiting_for_opponent"
    # Opaque guest token must never be serialized into shared game state.
    assert "guest_id" not in game
    assert "player1_guest_id" not in game

    join = career_client.post(
        "/quiz/career/games/join",
        json={"join_code": game["join_code"], "player_name": "Joiner", "guest_id": "joiner-guest-xyz"},
    )
    assert join.status_code == 200
    assert join.json()["payload"]["game"]["status"] == "active"

    with career_client.session_local() as db:
        stored = db.get(CareerQuizGame, game["id"])
        assert stored.player1_guest_id == "host-guest-xyz"
        assert stored.player2_guest_id == "joiner-guest-xyz"


def test_career_http_create_and_join_without_guest_id(career_client: TestClient):
    create = career_client.post(
        "/quiz/career/games",
        json={"target_wins": 1, "player1_name": "Host"},
    )
    assert create.status_code == 200
    game = create.json()["payload"]["game"]

    join = career_client.post(
        "/quiz/career/games/join",
        json={"join_code": game["join_code"], "player_name": "Joiner"},
    )
    assert join.status_code == 200
    assert join.json()["payload"]["game"]["status"] == "active"

    with career_client.session_local() as db:
        stored = db.get(CareerQuizGame, game["id"])
        assert stored.player1_guest_id is None
        assert stored.player2_guest_id is None
