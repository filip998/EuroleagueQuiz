from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.game_actions import ConflictGameActionError, InvalidGameActionError
from app.main import app
from app.models import PhotoQuizGame, PhotoQuizRound, Player
from app.services import photo_quiz
from app.services.realtime_adapters import PhotoQuizRealtimeAdapter
from app.services.solo_round_token import create_solo_round_token, validate_solo_round_token


def test_eligible_pool_requires_wikipedia_page_and_any_usable_image():
    db = _session()
    try:
        cdn = _player(
            db,
            "CDN",
            "Eligible",
            wikipedia_url="https://wiki/cdn",
            euroleague_image_url="https://cdn/cdn.png",
        )
        wiki = _player(
            db,
            "Wiki",
            "Eligible",
            wikipedia_url="https://wiki/wiki",
            wikipedia_image_url="https://wiki/wiki.png",
        )
        _player(db, "NoWiki", "Image", euroleague_image_url="https://cdn/no-wiki.png")
        _player(db, "NoImage", "Wiki", wikipedia_url="https://wiki/no-image")
        _player(
            db,
            "Blank",
            "Image",
            wikipedia_url="https://wiki/blank",
            euroleague_image_url="   ",
        )
        db.commit()

        assert set(photo_quiz._eligible_player_ids(db)) == {cdn.id, wiki.id}
    finally:
        db.close()


def test_image_resolution_prefers_cdn_and_falls_back_to_wikipedia():
    db = _session()
    try:
        player = _player(
            db,
            "Image",
            "Priority",
            wikipedia_url="https://wiki/player",
            euroleague_image_url="https://cdn/player.png",
            wikipedia_image_url="https://wiki/player.png",
        )
        wiki_only = _player(
            db,
            "Wiki",
            "Only",
            wikipedia_url="https://wiki/only",
            wikipedia_image_url="https://wiki/only.png",
        )

        assert photo_quiz._resolve_photo_image_url(player) == "https://cdn/player.png"
        assert photo_quiz._resolve_photo_image_url(wiki_only) == "https://wiki/only.png"
    finally:
        db.close()


def test_solo_round_uses_wikipedia_image_fallback_without_revealing_answer():
    db = _session()
    try:
        player = _player(
            db,
            "Wiki",
            "Clue",
            wikipedia_url="https://wiki/clue",
            wikipedia_image_url="https://wiki/clue.png",
        )
        db.commit()

        round_data = photo_quiz.create_solo_round(db, recent_player_ids=[])

        assert round_data["image_url"] == "https://wiki/clue.png"
        assert round_data["data_revision"] == photo_quiz.PHOTO_QUIZ_DATA_REVISION
        assert "answer" not in round_data
        assert player.first_name not in repr(round_data)
        assert player.last_name not in repr(round_data)
        token_payload = validate_solo_round_token(
            round_data["round_token"],
            current_data_revision=photo_quiz.PHOTO_QUIZ_DATA_REVISION,
        )
        assert token_payload.player_id != player.id
    finally:
        db.close()


def test_solo_round_avoids_recent_players_when_alternatives_exist(monkeypatch):
    db = _session()
    try:
        recent = _player(
            db,
            "Recent",
            "Player",
            wikipedia_url="https://wiki/recent",
            euroleague_image_url="https://cdn/recent.png",
        )
        available = _player(
            db,
            "Available",
            "Player",
            wikipedia_url="https://wiki/available",
            euroleague_image_url="https://cdn/available.png",
        )
        db.commit()

        choices_seen = []

        def choose_first(ids):
            choices_seen.append(list(ids))
            return ids[0]

        monkeypatch.setattr(photo_quiz.random, "choice", choose_first)

        round_data = photo_quiz.create_solo_round(db, recent_player_ids=[recent.id])

        assert choices_seen == [[available.id]]
        assert round_data["image_url"] == "https://cdn/available.png"
    finally:
        db.close()


def test_solo_guess_and_reveal_hide_answer_until_correct_or_revealed(monkeypatch):
    db = _session()
    try:
        answer = _player(
            db,
            "Answer",
            "Player",
            wikipedia_url="https://wiki/answer",
            euroleague_image_url="https://cdn/answer.png",
        )
        wrong = _player(
            db,
            "Wrong",
            "Player",
            wikipedia_url="https://wiki/wrong",
            euroleague_image_url="https://cdn/wrong.png",
        )
        db.commit()

        monkeypatch.setattr(photo_quiz.random, "choice", lambda ids: answer.id)
        token = photo_quiz.create_solo_round(db, recent_player_ids=[])["round_token"]

        incorrect = photo_quiz.submit_solo_guess(
            db, round_token=token, player_id=wrong.id
        )
        assert incorrect == {"correct": False}

        correct = photo_quiz.submit_solo_guess(
            db, round_token=token, player_id=answer.id
        )
        assert correct["correct"] is True
        assert correct["answer"]["id"] == answer.id
        assert correct["answer"]["image_url"] == "https://cdn/answer.png"

        reveal = photo_quiz.reveal_solo_answer(db, round_token=token)
        assert reveal["answer"]["id"] == answer.id
    finally:
        db.close()


def test_photo_tokens_reject_other_data_revisions():
    db = _session()
    try:
        token = create_solo_round_token(player_id=1, data_revision="career-revision")

        with pytest.raises(InvalidGameActionError, match="Stale"):
            photo_quiz.submit_solo_guess(db, round_token=token, player_id=1)
    finally:
        db.close()


def test_token_payload_contains_round_token_id_not_answer_id():
    db = _session()
    try:
        answer = _player(
            db,
            "Hidden",
            "Answer",
            wikipedia_url="https://wiki/hidden",
            euroleague_image_url="https://cdn/hidden.png",
        )
        db.commit()

        token = photo_quiz.create_solo_round(db, recent_player_ids=[])["round_token"]
        payload = validate_solo_round_token(
            token,
            current_data_revision=photo_quiz.PHOTO_QUIZ_DATA_REVISION,
        )

        assert payload.player_id != answer.id
        assert (
            db.query(PhotoQuizRound)
            .filter(PhotoQuizRound.solo_token_id == payload.player_id)
            .one()
            .answer_player_id
            == answer.id
        )
    finally:
        db.close()


def test_empty_pool_has_clear_conflict_error():
    db = _session()
    try:
        with pytest.raises(ConflictGameActionError, match="Photo Quiz is not enabled"):
            photo_quiz.create_solo_round(db, recent_player_ids=[])
    finally:
        db.close()


def test_autocomplete_returns_only_photo_eligible_players_with_resolved_images():
    db = _session()
    try:
        cdn = _player(
            db,
            "Milos",
            "Cdn",
            wikipedia_url="https://wiki/cdn",
            euroleague_image_url="https://cdn/milos.png",
            wikipedia_image_url="https://wiki/milos-cdn.png",
        )
        wiki = _player(
            db,
            "Milos",
            "Wiki",
            wikipedia_url="https://wiki/wiki",
            wikipedia_image_url="https://wiki/milos-wiki.png",
        )
        _player(db, "Milos", "NoWiki", euroleague_image_url="https://cdn/no-wiki.png")
        _player(db, "Milos", "NoImage", wikipedia_url="https://wiki/no-image")
        db.commit()

        players = photo_quiz.autocomplete_players(db, q="milos", limit=10)

        assert [player["id"] for player in players] == [cdn.id, wiki.id]
        assert [player["image_url"] for player in players] == [
            "https://cdn/milos.png",
            "https://wiki/milos-wiki.png",
        ]
    finally:
        db.close()


def test_multiplayer_first_correct_answer_wins_match_when_target_is_one():
    db = _session()
    try:
        _player(
            db,
            "Answer",
            "Player",
            wikipedia_url="https://wiki/answer",
            euroleague_image_url="https://cdn/answer.png",
        )
        wrong = _player(
            db,
            "Wrong",
            "Guess",
            wikipedia_url="https://wiki/wrong",
            euroleague_image_url="https://cdn/wrong.png",
        )
        db.commit()

        game = photo_quiz.create_game(db, target_wins=1, player1_name="A")
        photo_quiz.join_game(db, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)
        wrong_id = wrong.id
        if wrong_id == current.answer_player_id:
            wrong_id = next(
                player.id
                for player in db.query(Player).all()
                if player.id != current.answer_player_id
            )

        assert (
            photo_quiz.submit_guess(
                db,
                game=game,
                player_id=wrong_id,
                acting_player=2,
                round_number=current.round_number,
            )
            == "incorrect"
        )

        result = photo_quiz.submit_guess(
            db,
            game=game,
            player_id=current.answer_player_id,
            acting_player=1,
            round_number=current.round_number,
        )

        assert result == "match_won"
        assert game.status == "finished"
        assert game.winner_player == 1
        assert photo_quiz.serialize_completed_round(db, game.id, 1)["answer"]["id"] == current.answer_player_id
    finally:
        db.close()


def test_multiplayer_shared_wrong_guesses_include_safe_image_payloads(monkeypatch):
    db = _session()
    try:
        answer = _player(
            db,
            "Shared",
            "Answer",
            wikipedia_url="https://wiki/answer",
            euroleague_image_url="https://cdn/answer.png",
        )
        wiki_wrong = _player(
            db,
            "Shared",
            "WikiWrong",
            wikipedia_url="https://wiki/wrong",
            wikipedia_image_url="https://wiki/wrong.png",
        )
        image_less_wrong = _player(db, "Shared", "NoImage")
        db.commit()

        game = photo_quiz.create_game(
            db,
            target_wins=3,
            wrong_guess_visibility="shared",
            player1_name="A",
        )
        monkeypatch.setattr(photo_quiz.random, "choice", lambda ids: answer.id)
        photo_quiz.join_game(db, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)

        assert current.answer_player_id == answer.id
        assert (
            photo_quiz.submit_guess(
                db,
                game=game,
                player_id=wiki_wrong.id,
                acting_player=1,
                round_number=current.round_number,
            )
            == "incorrect"
        )
        assert (
            photo_quiz.submit_guess(
                db,
                game=game,
                player_id=image_less_wrong.id,
                acting_player=2,
                round_number=current.round_number,
            )
            == "incorrect"
        )

        current_round = photo_quiz.serialize_game_state(db, game)["current_round"]

        assert current_round["wrong_guesses"] == [
            {
                "player_number": 1,
                "player": {
                    "id": wiki_wrong.id,
                    "name": "Shared WikiWrong",
                    "image_url": "https://wiki/wrong.png",
                },
            },
            {
                "player_number": 2,
                "player": {
                    "id": image_less_wrong.id,
                    "name": "Shared NoImage",
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
            _player(
                db,
                "Private",
                "Answer",
                wikipedia_url="https://wiki/answer",
                euroleague_image_url="https://cdn/answer.png",
            ),
            _player(
                db,
                "Private",
                "Wrong",
                wikipedia_url="https://wiki/wrong",
                euroleague_image_url="https://cdn/wrong.png",
            ),
        ]
        db.commit()

        game = photo_quiz.create_game(
            db,
            target_wins=3,
            wrong_guess_visibility="private",
            player1_name="A",
        )
        photo_quiz.join_game(db, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)
        wrong_player = next(
            player for player in players if player.id != current.answer_player_id
        )

        assert (
            photo_quiz.submit_guess(
                db,
                game=game,
                player_id=wrong_player.id,
                acting_player=2,
                round_number=current.round_number,
            )
            == "incorrect"
        )

        current_round = photo_quiz.serialize_game_state(db, game)["current_round"]

        assert "wrong_guesses" not in current_round
        assert wrong_player.last_name not in repr(current_round)
    finally:
        db.close()


def test_realtime_adapter_targets_private_wrong_guess_to_actor_only():
    db = _session()
    try:
        players = [
            _player(
                db,
                "Private",
                "RealtimeAnswer",
                wikipedia_url="https://wiki/answer",
                euroleague_image_url="https://cdn/answer.png",
            ),
            _player(
                db,
                "Private",
                "RealtimeWrong",
                wikipedia_url="https://wiki/wrong",
                euroleague_image_url="https://cdn/wrong.png",
            ),
        ]
        db.commit()

        game = photo_quiz.create_game(
            db,
            target_wins=3,
            wrong_guess_visibility="private",
            player1_name="A",
        )
        photo_quiz.join_game(db, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)
        wrong_player = next(
            player for player in players if player.id != current.answer_player_id
        )

        outcome = PhotoQuizRealtimeAdapter().handle_client_action(
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
            _player(
                db,
                "Shared",
                "RealtimeAnswer",
                wikipedia_url="https://wiki/answer",
                euroleague_image_url="https://cdn/answer.png",
            ),
            _player(
                db,
                "Shared",
                "RealtimeWrong",
                wikipedia_url="https://wiki/wrong",
                euroleague_image_url="https://cdn/wrong.png",
            ),
        ]
        db.commit()

        game = photo_quiz.create_game(
            db,
            target_wins=3,
            wrong_guess_visibility="shared",
            player1_name="A",
        )
        photo_quiz.join_game(db, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)
        wrong_player = next(
            player for player in players if player.id != current.answer_player_id
        )

        outcome = PhotoQuizRealtimeAdapter().handle_client_action(
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
        _player(
            db,
            "Answer",
            "Player",
            wikipedia_url="https://wiki/answer",
            euroleague_image_url="https://cdn/answer.png",
        )
        _player(
            db,
            "Next",
            "Player",
            wikipedia_url="https://wiki/next",
            euroleague_image_url="https://cdn/next.png",
        )
        db.commit()

        game = photo_quiz.create_game(db, target_wins=3, player1_name="A")
        photo_quiz.join_game(db, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)

        assert photo_quiz.serialize_game_state(db, game)["latest_completed_round"] is None

        photo_quiz.offer_no_answer(
            db,
            game=game,
            acting_player=1,
            round_number=current.round_number,
        )
        result = photo_quiz.respond_no_answer(
            db,
            game=game,
            acting_player=2,
            accept=True,
            round_number=current.round_number,
        )

        assert result == "accepted"
        completed = photo_quiz.serialize_game_state(db, game)["latest_completed_round"]
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
        _player(
            db,
            "Correct",
            "Answer",
            wikipedia_url="https://wiki/correct",
            euroleague_image_url="https://cdn/correct.png",
        )
        _player(
            db,
            "Future",
            "Round",
            wikipedia_url="https://wiki/future",
            euroleague_image_url="https://cdn/future.png",
        )
        db.commit()

        game = photo_quiz.create_game(db, target_wins=3, player1_name="A")
        photo_quiz.join_game(db, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)

        result = photo_quiz.submit_guess(
            db,
            game=game,
            player_id=current.answer_player_id,
            acting_player=1,
            round_number=current.round_number,
        )

        assert result == "round_won"
        completed = photo_quiz.serialize_game_state(db, game)["latest_completed_round"]
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
        for index in range(3):
            _player(
                db,
                "Reveal",
                f"Player{index}",
                wikipedia_url=f"https://wiki/reveal-{index}",
                euroleague_image_url=f"https://cdn/reveal-{index}.png",
            )
        db.commit()

        game = photo_quiz.create_game(db, target_wins=3, player1_name="A")
        photo_quiz.join_game(db, game.join_code, player_name="B")
        completed_round = photo_quiz._current_round(game)
        result = photo_quiz.submit_guess(
            db,
            game=game,
            player_id=completed_round.answer_player_id,
            acting_player=1,
            round_number=completed_round.round_number,
        )

        assert result == "round_won"
        locked_round = photo_quiz._current_round(game)
        with pytest.raises(ConflictGameActionError, match="round_locked"):
            photo_quiz.submit_guess(
                db,
                game=game,
                player_id=locked_round.answer_player_id,
                acting_player=2,
                round_number=locked_round.round_number,
            )

        completed_round.completed_at = datetime.utcnow() - timedelta(
            seconds=photo_quiz.PHOTO_REVEAL_COUNTDOWN_SECONDS + 1
        )
        db.flush()
        assert (
            photo_quiz.serialize_game_state(db, game)["latest_completed_round"][
                "next_round_starts_at"
            ]
            is None
        )

        result = photo_quiz.submit_guess(
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
        _player(
            db,
            "No",
            "Answer",
            wikipedia_url="https://wiki/no",
            euroleague_image_url="https://cdn/no.png",
        )
        _player(
            db,
            "Locked",
            "Round",
            wikipedia_url="https://wiki/locked",
            euroleague_image_url="https://cdn/locked.png",
        )
        db.commit()

        game = photo_quiz.create_game(db, target_wins=3, player1_name="A")
        photo_quiz.join_game(db, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)
        photo_quiz.offer_no_answer(
            db,
            game=game,
            acting_player=1,
            round_number=current.round_number,
        )
        result = photo_quiz.respond_no_answer(
            db,
            game=game,
            acting_player=2,
            accept=True,
            round_number=current.round_number,
        )

        assert result == "accepted"
        locked_round = photo_quiz._current_round(game)
        with pytest.raises(ConflictGameActionError, match="round_locked"):
            photo_quiz.submit_guess(
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
        for index in range(3):
            _player(
                db,
                "Stale",
                f"Player{index}",
                wikipedia_url=f"https://wiki/stale-{index}",
                euroleague_image_url=f"https://cdn/stale-{index}.png",
            )
        db.commit()

        game = photo_quiz.create_game(db, target_wins=3, player1_name="A")
        photo_quiz.join_game(db, game.join_code, player_name="B")
        completed_round = photo_quiz._current_round(game)
        result = photo_quiz.submit_guess(
            db,
            game=game,
            player_id=completed_round.answer_player_id,
            acting_player=1,
            round_number=completed_round.round_number,
        )
        assert result == "round_won"
        completed_round.completed_at = datetime.utcnow() - timedelta(
            seconds=photo_quiz.PHOTO_REVEAL_COUNTDOWN_SECONDS + 1
        )
        current_round = photo_quiz._current_round(game)

        with pytest.raises(ConflictGameActionError, match="round_stale"):
            photo_quiz.submit_guess(
                db,
                game=game,
                player_id=current_round.answer_player_id,
                acting_player=2,
                round_number=completed_round.round_number,
            )

        with pytest.raises(ConflictGameActionError, match="round_stale"):
            photo_quiz.offer_no_answer(
                db,
                game=game,
                acting_player=2,
                round_number=completed_round.round_number,
            )

        with pytest.raises(ConflictGameActionError, match="round_stale"):
            photo_quiz.respond_no_answer(
                db,
                game=game,
                acting_player=2,
                accept=True,
                round_number=completed_round.round_number,
            )
    finally:
        db.close()


def test_multiplayer_stale_correct_guess_from_second_session_is_rejected(tmp_path: Path):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        for index in range(3):
            _player(
                setup,
                "Race",
                f"Player{index}",
                wikipedia_url=f"https://wiki/race-{index}",
                euroleague_image_url=f"https://cdn/race-{index}.png",
            )
        setup.commit()
        game = photo_quiz.create_game(setup, target_wins=3, player1_name="A")
        photo_quiz.join_game(setup, game.join_code, player_name="B")
        game_id = game.id
        setup.commit()
    finally:
        setup.close()

    first = SessionLocal()
    second = SessionLocal()
    try:
        first_game = first.get(PhotoQuizGame, game_id)
        second_game = second.get(PhotoQuizGame, game_id)
        first_round = photo_quiz._current_round(first_game)
        second_round = photo_quiz._current_round(second_game)

        assert (
            photo_quiz.submit_guess(
                first,
                game=first_game,
                player_id=first_round.answer_player_id,
                acting_player=1,
                round_number=first_round.round_number,
            )
            == "round_won"
        )
        first.commit()

        with pytest.raises(ConflictGameActionError, match="round_stale"):
            photo_quiz.submit_guess(
                second,
                game=second_game,
                player_id=second_round.answer_player_id,
                acting_player=2,
                round_number=second_round.round_number,
            )
        second.rollback()
    finally:
        first.close()
        second.close()

    verify = SessionLocal()
    try:
        stored = verify.get(PhotoQuizGame, game_id)
        assert stored.player1_score == 1
        assert stored.player2_score == 0
        assert stored.round_number == 2
        assert stored.status == "active"
        assert len(stored.rounds) == 2
    finally:
        verify.close()


def test_multiplayer_stale_no_answer_accept_after_correct_guess_is_rejected(tmp_path: Path):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        for index in range(3):
            _player(
                setup,
                "NoAnswerRace",
                f"Player{index}",
                wikipedia_url=f"https://wiki/no-answer-race-{index}",
                euroleague_image_url=f"https://cdn/no-answer-race-{index}.png",
            )
        setup.commit()
        game = photo_quiz.create_game(setup, target_wins=3, player1_name="A")
        photo_quiz.join_game(setup, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)
        photo_quiz.offer_no_answer(
            setup,
            game=game,
            acting_player=1,
            round_number=current.round_number,
        )
        game_id = game.id
        setup.commit()
    finally:
        setup.close()

    first = SessionLocal()
    second = SessionLocal()
    try:
        first_game = first.get(PhotoQuizGame, game_id)
        second_game = second.get(PhotoQuizGame, game_id)
        first_round = photo_quiz._current_round(first_game)
        second_round = photo_quiz._current_round(second_game)

        assert (
            photo_quiz.submit_guess(
                first,
                game=first_game,
                player_id=first_round.answer_player_id,
                acting_player=2,
                round_number=first_round.round_number,
            )
            == "round_won"
        )
        first.commit()

        with pytest.raises(ConflictGameActionError, match="round_stale"):
            photo_quiz.respond_no_answer(
                second,
                game=second_game,
                acting_player=2,
                accept=True,
                round_number=second_round.round_number,
            )
        second.rollback()
    finally:
        first.close()
        second.close()

    verify = SessionLocal()
    try:
        stored = verify.get(PhotoQuizGame, game_id)
        assert stored.player1_score == 0
        assert stored.player2_score == 1
        assert stored.pending_no_answer_from is None
        assert stored.pending_no_answer_to is None
        assert stored.round_number == 2
    finally:
        verify.close()


def test_photo_http_create_join_get_and_guess_envelopes(photo_client: TestClient):
    create = photo_client.post(
        "/quiz/photo/games",
        json={
            "target_wins": 1,
            "player1_name": "Host",
            "guest_id": "host-guest-xyz",
        },
    )
    assert create.status_code == 200
    create_body = create.json()
    assert create_body["type"] == "state"
    game = create_body["payload"]["game"]
    assert game["status"] == "waiting_for_opponent"
    assert game["mode"] == "online_friend"
    assert "guest_id" not in game
    assert "player1_guest_id" not in game

    join = photo_client.post(
        "/quiz/photo/games/join",
        json={
            "join_code": game["join_code"],
            "player_name": "Joiner",
            "guest_id": "joiner-guest-xyz",
        },
    )
    assert join.status_code == 200
    joined_game = join.json()["payload"]["game"]
    assert joined_game["status"] == "active"
    assert joined_game["current_round"]["round_number"] == 1
    assert joined_game["current_round"]["image_url"]

    get_game = photo_client.get(f"/quiz/photo/games/{game['id']}")
    assert get_game.status_code == 200
    plain_state = get_game.json()
    assert plain_state["id"] == game["id"]
    assert "type" not in plain_state

    with photo_client.session_local() as db:
        stored = db.get(PhotoQuizGame, game["id"])
        assert stored.player1_guest_id == "host-guest-xyz"
        assert stored.player2_guest_id == "joiner-guest-xyz"
        current = photo_quiz._current_round(stored)
        answer_id = current.answer_player_id
        round_number = current.round_number

    guess = photo_client.post(
        f"/quiz/photo/games/{game['id']}/guess?player=1",
        json={"player_id": answer_id, "round_number": round_number},
    )
    assert guess.status_code == 200
    guess_body = guess.json()
    assert guess_body["type"] == "state"
    assert guess_body["payload"]["result"] == "match_won"
    assert guess_body["payload"]["terminal"] is True


def _session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _file_session_factory(tmp_path: Path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'photo_concurrency_test.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _player(
    db,
    first_name: str,
    last_name: str,
    *,
    wikipedia_url: str | None = None,
    euroleague_image_url: str | None = None,
    wikipedia_image_url: str | None = None,
):
    player = Player(
        euroleague_code=f"P{first_name}{last_name}",
        first_name=first_name,
        last_name=last_name,
        wikipedia_url=wikipedia_url,
        euroleague_image_url=euroleague_image_url,
        wikipedia_image_url=wikipedia_image_url,
    )
    db.add(player)
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
        seconds=photo_quiz.PHOTO_REVEAL_COUNTDOWN_SECONDS
    )


@pytest.fixture()
def photo_client(tmp_path: Path):
    db_path = tmp_path / "photo_api_test.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        for index in range(5):
            _player(
                session,
                f"First{index}",
                f"Last{index}",
                wikipedia_url=f"https://wiki/player-{index}",
                euroleague_image_url=f"https://cdn/player-{index}.png",
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
