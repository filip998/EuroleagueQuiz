import asyncio
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
from app.routers import photo_quiz as photo_quiz_router
from app.schemas.realtime import RealtimeResult, RealtimeServerMessageAdapter
from app.services import photo_quiz
from app.services.realtime_adapters import PhotoQuizRealtimeAdapter
from app.services.realtime import (
    DisconnectGraceTimerManager,
    OnlineGameRealtimeModule,
    TurnTimerManager,
)
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
        both = _player(
            db,
            "Both",
            "Eligible",
            wikipedia_url="https://wiki/both",
            euroleague_image_url="https://cdn/both.png",
            wikipedia_image_url="https://wiki/both.png",
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

        assert set(photo_quiz._eligible_player_ids(db)) == {cdn.id, wiki.id, both.id}
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
        public_clue_payload = {
            key: value for key, value in round_data.items() if key != "round_token"
        }
        assert player.first_name not in repr(public_clue_payload)
        assert player.last_name not in repr(public_clue_payload)
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


def test_multiplayer_first_to_three_requires_three_round_wins(monkeypatch):
    db = _session()
    try:
        players = [
            _player(
                db,
                "Race",
                f"Answer{index}",
                wikipedia_url=f"https://wiki/race-answer-{index}",
                euroleague_image_url=f"https://cdn/race-answer-{index}.png",
            )
            for index in range(4)
        ]
        db.commit()
        answer_ids = [player.id for player in players[:3]]

        game = photo_quiz.create_game(db, target_wins=3, player1_name="A")
        monkeypatch.setattr(photo_quiz.random, "choice", lambda _ids: answer_ids.pop(0))
        photo_quiz.join_game(db, game.join_code, player_name="B")

        for expected_score in (1, 2):
            current = photo_quiz._current_round(game)
            assert (
                photo_quiz.submit_guess(
                    db,
                    game=game,
                    player_id=current.answer_player_id,
                    acting_player=1,
                    round_number=current.round_number,
                )
                == "round_won"
            )
            assert game.status == "active"
            assert game.winner_player is None
            assert game.player1_score == expected_score
            assert game.player2_score == 0
            current.completed_at = datetime.utcnow() - timedelta(
                seconds=photo_quiz.PHOTO_REVEAL_COUNTDOWN_SECONDS + 1
            )

        current = photo_quiz._current_round(game)
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
        assert game.player1_score == 3
        assert game.player2_score == 0
        assert len(game.rounds) == 3
    finally:
        db.close()


def test_multiplayer_stale_second_join_is_rejected_without_duplicate_round(tmp_path: Path):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        _player(
            setup,
            "JoinRace",
            "One",
            wikipedia_url="https://wiki/join-race-one",
            euroleague_image_url="https://cdn/join-race-one.png",
        )
        setup.commit()
        game = photo_quiz.create_game(setup, target_wins=1, player1_name="A")
        game_id = game.id
        setup.commit()
    finally:
        setup.close()

    first = SessionLocal()
    second = SessionLocal()
    try:
        first_game = first.get(PhotoQuizGame, game_id)
        second_game = second.get(PhotoQuizGame, game_id)

        photo_quiz.join_game(first, first_game.join_code, player_name="B")
        first.commit()

        with pytest.raises(
            ConflictGameActionError,
            match="Game is not waiting for an opponent",
        ):
            photo_quiz.join_game(second, second_game.join_code, player_name="C")
        second.rollback()
    finally:
        first.close()
        second.close()

    verify = SessionLocal()
    try:
        stored = verify.get(PhotoQuizGame, game_id)
        assert stored.status == "active"
        assert stored.player2_name == "B"
        assert len(stored.rounds) == 1
        assert stored.rounds[0].round_number == 1
    finally:
        verify.close()


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
        no_answer_offer_version = game.no_answer_offer_version
        result = photo_quiz.respond_no_answer(
            db,
            game=game,
            acting_player=2,
            accept=True,
            round_number=current.round_number,
            no_answer_offer_version=no_answer_offer_version,
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


def test_multiplayer_stale_second_no_answer_offer_is_rejected(tmp_path: Path):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        for index in range(2):
            _player(
                setup,
                "OfferRace",
                f"Player{index}",
                wikipedia_url=f"https://wiki/offer-race-{index}",
                euroleague_image_url=f"https://cdn/offer-race-{index}.png",
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

        photo_quiz.offer_no_answer(
            first,
            game=first_game,
            acting_player=1,
            round_number=first_round.round_number,
        )
        first.commit()

        with pytest.raises(
            ConflictGameActionError,
            match="No answer offer is already pending",
        ):
            photo_quiz.offer_no_answer(
                second,
                game=second_game,
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
        assert stored.pending_no_answer_from == 1
        assert stored.pending_no_answer_to == 2
        assert stored.no_answer_offer_version == 1
        assert stored.round_number == 1
        assert [round_obj.status for round_obj in stored.rounds] == ["active"]
    finally:
        verify.close()


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
        no_answer_offer_version = game.no_answer_offer_version
        result = photo_quiz.respond_no_answer(
            db,
            game=game,
            acting_player=2,
            accept=True,
            round_number=current.round_number,
            no_answer_offer_version=no_answer_offer_version,
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
                no_answer_offer_version=1,
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
        second_offer_version = second_game.no_answer_offer_version

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


def test_multiplayer_stale_incorrect_guess_after_correct_guess_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        player_ids = [
            _player(
                setup,
                "IncorrectRace",
                f"Player{index}",
                wikipedia_url=f"https://wiki/incorrect-race-{index}",
                euroleague_image_url=f"https://cdn/incorrect-race-{index}.png",
            ).id
            for index in range(3)
        ]
        setup.commit()
        game = photo_quiz.create_game(setup, target_wins=3, player1_name="A")
        photo_quiz.join_game(setup, game.join_code, player_name="B")
        current = photo_quiz._current_round(game)
        answer_id = current.answer_player_id
        wrong_player_id = next(
            player_id for player_id in player_ids if player_id != answer_id
        )
        game_id = game.id
        setup.commit()
    finally:
        setup.close()

    original_assert_active_game_round = photo_quiz._assert_active_game_round
    raced = False

    def complete_round_after_stale_read(db, game, round_obj, round_number):
        nonlocal raced
        original_assert_active_game_round(db, game, round_obj, round_number)
        if raced:
            return
        raced = True
        winner = SessionLocal()
        try:
            winner_game = winner.get(PhotoQuizGame, game_id)
            winner_round = photo_quiz._current_round(winner_game)
            assert (
                photo_quiz.submit_guess(
                    winner,
                    game=winner_game,
                    player_id=winner_round.answer_player_id,
                    acting_player=2,
                    round_number=winner_round.round_number,
                )
                == "round_won"
            )
            winner.commit()
        finally:
            winner.close()

    monkeypatch.setattr(
        photo_quiz,
        "_assert_active_game_round",
        complete_round_after_stale_read,
    )

    stale = SessionLocal()
    try:
        stale_game = stale.get(PhotoQuizGame, game_id)
        stale_round = photo_quiz._current_round(stale_game)

        with pytest.raises(ConflictGameActionError, match="round_stale"):
            photo_quiz.submit_guess(
                stale,
                game=stale_game,
                player_id=wrong_player_id,
                acting_player=1,
                round_number=stale_round.round_number,
            )
        stale.rollback()
    finally:
        stale.close()

    verify = SessionLocal()
    try:
        stored = verify.get(PhotoQuizGame, game_id)
        assert stored.round_number == 2
        assert stored.player1_score == 0
        assert stored.player2_score == 1
        first_round = stored.rounds[0]
        assert first_round.status == "completed"
        assert [
            (guess.player_number, guess.is_correct) for guess in first_round.guesses
        ] == [(2, True)]
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
        second_offer_version = second_game.no_answer_offer_version

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
                no_answer_offer_version=second_offer_version,
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


def test_multiplayer_stale_no_answer_accept_after_decline_is_rejected(tmp_path: Path):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        for index in range(2):
            _player(
                setup,
                "NoAnswerDeclineRace",
                f"Player{index}",
                wikipedia_url=f"https://wiki/no-answer-decline-race-{index}",
                euroleague_image_url=f"https://cdn/no-answer-decline-race-{index}.png",
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
        first_offer_version = first_game.no_answer_offer_version
        second_offer_version = second_game.no_answer_offer_version

        assert (
            photo_quiz.respond_no_answer(
                first,
                game=first_game,
                acting_player=2,
                accept=False,
                round_number=first_round.round_number,
                no_answer_offer_version=first_offer_version,
            )
            == "declined"
        )
        first.commit()

        with pytest.raises(
            ConflictGameActionError,
            match="No answer offer is not pending for this player",
        ):
            photo_quiz.respond_no_answer(
                second,
                game=second_game,
                acting_player=2,
                accept=True,
                round_number=second_round.round_number,
                no_answer_offer_version=second_offer_version,
            )
        second.rollback()
    finally:
        first.close()
        second.close()

    verify = SessionLocal()
    try:
        stored = verify.get(PhotoQuizGame, game_id)
        assert stored.player1_score == 0
        assert stored.player2_score == 0
        assert stored.pending_no_answer_from is None
        assert stored.pending_no_answer_to is None
        assert stored.round_number == 1
        assert [round_obj.status for round_obj in stored.rounds] == ["active"]
    finally:
        verify.close()


def test_multiplayer_stale_no_answer_accept_after_reoffer_is_rejected(tmp_path: Path):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        for index in range(2):
            _player(
                setup,
                "NoAnswerReofferRace",
                f"Player{index}",
                wikipedia_url=f"https://wiki/no-answer-reoffer-race-{index}",
                euroleague_image_url=f"https://cdn/no-answer-reoffer-race-{index}.png",
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

    stale = SessionLocal()
    decline = SessionLocal()
    reoffer = SessionLocal()
    try:
        stale_game = stale.get(PhotoQuizGame, game_id)
        stale_round = photo_quiz._current_round(stale_game)
        stale_offer_version = stale_game.no_answer_offer_version

        decline_game = decline.get(PhotoQuizGame, game_id)
        decline_round = photo_quiz._current_round(decline_game)
        decline_offer_version = decline_game.no_answer_offer_version
        assert (
            photo_quiz.respond_no_answer(
                decline,
                game=decline_game,
                acting_player=2,
                accept=False,
                round_number=decline_round.round_number,
                no_answer_offer_version=decline_offer_version,
            )
            == "declined"
        )
        decline.commit()

        reoffer_game = reoffer.get(PhotoQuizGame, game_id)
        reoffer_round = photo_quiz._current_round(reoffer_game)
        photo_quiz.offer_no_answer(
            reoffer,
            game=reoffer_game,
            acting_player=1,
            round_number=reoffer_round.round_number,
        )
        reoffer.commit()

        with pytest.raises(
            ConflictGameActionError,
            match="No answer offer is not pending for this player",
        ):
            photo_quiz.respond_no_answer(
                stale,
                game=stale_game,
                acting_player=2,
                accept=True,
                round_number=stale_round.round_number,
                no_answer_offer_version=stale_offer_version,
            )
        stale.rollback()
    finally:
        stale.close()
        decline.close()
        reoffer.close()

    verify = SessionLocal()
    try:
        stored = verify.get(PhotoQuizGame, game_id)
        assert stored.player1_score == 0
        assert stored.player2_score == 0
        assert stored.pending_no_answer_from == 1
        assert stored.pending_no_answer_to == 2
        assert stored.round_number == 1
        assert [round_obj.status for round_obj in stored.rounds] == ["active"]
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


def test_photo_http_rejects_replayed_no_answer_response_for_reoffer(
    photo_client: TestClient,
):
    create = photo_client.post(
        "/quiz/photo/games",
        json={"target_wins": 3, "player1_name": "Host"},
    )
    assert create.status_code == 200
    game = create.json()["payload"]["game"]

    join = photo_client.post(
        "/quiz/photo/games/join",
        json={"join_code": game["join_code"], "player_name": "Joiner"},
    )
    assert join.status_code == 200
    joined_game = join.json()["payload"]["game"]
    game_id = joined_game["id"]
    round_number = joined_game["round_number"]

    first_offer = photo_client.post(
        f"/quiz/photo/games/{game_id}/no-answer-offer?player=1",
        json={"round_number": round_number},
    )
    assert first_offer.status_code == 200
    first_offer_game = first_offer.json()["payload"]["game"]
    first_offer_version = first_offer_game["pending_no_answer_offer_version"]
    assert first_offer_version == 1

    decline = photo_client.post(
        f"/quiz/photo/games/{game_id}/no-answer-response?player=2",
        json={
            "accept": False,
            "round_number": round_number,
            "no_answer_offer_version": first_offer_version,
        },
    )
    assert decline.status_code == 200
    assert decline.json()["payload"]["game"]["pending_no_answer_offer_version"] is None

    second_offer = photo_client.post(
        f"/quiz/photo/games/{game_id}/no-answer-offer?player=1",
        json={"round_number": round_number},
    )
    assert second_offer.status_code == 200
    second_offer_game = second_offer.json()["payload"]["game"]
    assert second_offer_game["pending_no_answer_offer_version"] == 2

    replayed_decline = photo_client.post(
        f"/quiz/photo/games/{game_id}/no-answer-response?player=2",
        json={
            "accept": False,
            "round_number": round_number,
            "no_answer_offer_version": first_offer_version,
        },
    )
    assert replayed_decline.status_code == 409
    assert replayed_decline.json()["payload"]["code"] == "conflict"

    state = photo_client.get(f"/quiz/photo/games/{game_id}")
    assert state.status_code == 200
    current_game = state.json()
    assert current_game["pending_no_answer_from"] == 1
    assert current_game["pending_no_answer_to"] == 2
    assert current_game["pending_no_answer_offer_version"] == 2
    assert current_game["round_number"] == round_number


def test_photo_quick_match_first_request_waits_with_public_preset(
    photo_client: TestClient,
):
    response = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "quick",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )

    assert response.status_code == 200
    game = _state_payload(response)["game"]
    assert game["status"] == "waiting_for_opponent"
    assert game["mode"] == "online_friend"
    assert game["join_code"] is None
    assert game["is_public"] is True
    assert game["preset"] == "quick"
    assert game["target_wins"] == 1
    assert game["wrong_guess_visibility"] == "private"
    assert game["current_round"] is None
    assert "guest_id" not in game
    assert "player1_guest_id" not in game


def test_photo_quick_match_pools_tracks_public_waiting_active_cancel_and_finish(
    photo_client: TestClient,
    photo_quick_match_effects,
):
    friend = photo_client.post(
        "/quiz/photo/games",
        json={
            "target_wins": 3,
            "player1_name": "Friend Host",
            "guest_id": "friend-guest",
        },
    )
    assert friend.status_code == 200
    friend_game = _state_payload(friend)["game"]
    assert friend_game["is_public"] is False
    assert friend_game["preset"] is None

    empty_counts = photo_client.get("/quiz/photo/quick-match/pools")
    assert empty_counts.status_code == 200
    assert empty_counts.json() == {
        "pools": {
            "quick": {"searching": 0, "in_progress": 0},
            "standard": {"searching": 0, "in_progress": 0},
            "long": {"searching": 0, "in_progress": 0},
        },
        "poll_interval_seconds": 5,
    }

    first = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "standard",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )
    assert first.status_code == 200
    standard_game = _state_payload(first)["game"]

    waiting_counts = photo_client.get("/quiz/photo/quick-match/pools")
    assert waiting_counts.status_code == 200
    assert waiting_counts.json()["pools"]["standard"] == {
        "searching": 1,
        "in_progress": 0,
    }

    second = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "standard",
            "player_name": "Joiner",
            "guest_id": "joiner-guest",
        },
    )
    assert second.status_code == 200
    matched_game = _state_payload(second)["game"]
    assert matched_game["id"] == standard_game["id"]
    assert matched_game["status"] == "active"
    assert matched_game["current_round"]["round_number"] == 1
    assert matched_game["is_public"] is True
    assert matched_game["preset"] == "standard"
    assert matched_game["target_wins"] == 3
    assert matched_game["wrong_guess_visibility"] == "private"
    assert photo_quick_match_effects["started"] == [matched_game["id"]]
    assert [item[0] for item in photo_quick_match_effects["broadcasts"]] == [
        matched_game["id"]
    ]

    active_counts = photo_client.get("/quiz/photo/quick-match/pools")
    assert active_counts.status_code == 200
    assert active_counts.json()["pools"]["standard"] == {
        "searching": 0,
        "in_progress": 1,
    }

    long_search = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "long",
            "player_name": "Long Host",
            "guest_id": "long-host-guest",
        },
    )
    assert long_search.status_code == 200
    long_game = _state_payload(long_search)["game"]

    mixed_counts = photo_client.get("/quiz/photo/quick-match/pools")
    assert mixed_counts.status_code == 200
    assert mixed_counts.json()["pools"]["standard"] == {
        "searching": 0,
        "in_progress": 1,
    }
    assert mixed_counts.json()["pools"]["long"] == {
        "searching": 1,
        "in_progress": 0,
    }

    cancel = photo_client.post(
        "/quiz/photo/quick-match/cancel",
        json={
            "preset": "long",
            "game_id": long_game["id"],
            "guest_id": "long-host-guest",
        },
    )
    assert cancel.status_code == 200
    cancelled_game = _state_payload(cancel)["game"]
    assert cancelled_game["id"] == long_game["id"]
    assert cancelled_game["status"] == "cancelled"
    assert cancelled_game["is_public"] is True
    assert cancelled_game["preset"] == "long"

    with photo_client.session_local() as db:
        assert db.get(PhotoQuizGame, long_game["id"]) is None
        stored = db.get(PhotoQuizGame, standard_game["id"])
        stored.status = "finished"
        db.commit()

    final_counts = photo_client.get("/quiz/photo/quick-match/pools")
    assert final_counts.status_code == 200
    assert final_counts.json()["pools"]["standard"] == {
        "searching": 0,
        "in_progress": 0,
    }
    assert final_counts.json()["pools"]["long"] == {
        "searching": 0,
        "in_progress": 0,
    }


def test_photo_quick_match_rejects_unknown_preset_with_error_envelope(
    photo_client: TestClient,
):
    response = photo_client.post(
        "/quiz/photo/quick-match",
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
            "message": "Unknown Photo Quiz matchmaking preset",
        },
    }


def test_photo_quick_match_same_guest_does_not_self_match(
    photo_client: TestClient,
    photo_quick_match_effects,
):
    first = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "standard",
            "player_name": "First",
            "guest_id": "same-guest",
        },
    )
    assert first.status_code == 200
    first_game = _state_payload(first)["game"]

    second = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "standard",
            "player_name": "Second",
            "guest_id": "same-guest",
        },
    )
    assert second.status_code == 200
    second_game = _state_payload(second)["game"]
    assert second_game["id"] == first_game["id"]
    assert second_game["status"] == "waiting_for_opponent"
    assert photo_quick_match_effects["started"] == []
    assert photo_quick_match_effects["broadcasts"] == []

    third = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "standard",
            "player_name": "Third",
            "guest_id": "other-guest",
        },
    )
    assert third.status_code == 200
    third_game = _state_payload(third)["game"]
    assert third_game["id"] == first_game["id"]
    assert third_game["status"] == "active"


def test_photo_quick_match_public_join_code_cannot_bypass_matchmaking(
    photo_client: TestClient,
    photo_quick_match_effects,
):
    search = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "standard",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )
    assert search.status_code == 200
    public_state = _state_payload(search)["game"]
    assert public_state["join_code"] is None

    with photo_client.session_local() as db:
        stored = db.get(PhotoQuizGame, public_state["id"])
        stored_join_code = stored.join_code

    bypass = photo_client.post(
        "/quiz/photo/games/join",
        json={
            "join_code": stored_join_code,
            "player_name": "Bypass",
            "guest_id": "joiner-guest",
        },
    )

    assert bypass.status_code == 409
    assert bypass.json() == {
        "type": "error",
        "payload": {
            "code": "conflict",
            "message": "Public games must be joined through quick match",
        },
    }
    assert photo_quick_match_effects["started"] == []

    with photo_client.session_local() as db:
        stored = db.get(PhotoQuizGame, public_state["id"])
        assert stored.status == "waiting_for_opponent"
        assert stored.player2_guest_id is None


def test_photo_quick_match_no_answer_requires_mutual_agreement(
    photo_client: TestClient,
    photo_quick_match_effects,
):
    first = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "standard",
            "player_name": "Host",
            "guest_id": "host-guest",
        },
    )
    assert first.status_code == 200
    second = photo_client.post(
        "/quiz/photo/quick-match",
        json={
            "preset": "standard",
            "player_name": "Joiner",
            "guest_id": "joiner-guest",
        },
    )
    assert second.status_code == 200
    game = _state_payload(second)["game"]

    round_number = game["round_number"]

    offer = photo_client.post(
        f"/quiz/photo/games/{game['id']}/no-answer-offer?player=1",
        json={"round_number": round_number},
    )
    assert offer.status_code == 200
    offered_game = offer.json()["payload"]["game"]
    first_offer_version = offered_game["pending_no_answer_offer_version"]
    assert offer.json()["payload"]["result"] == "no_answer_offered"
    assert offered_game["pending_no_answer_from"] == 1
    assert offered_game["pending_no_answer_to"] == 2
    assert offered_game["round_number"] == round_number
    assert offered_game["current_round"]["status"] == "active"
    assert offered_game["latest_completed_round"] is None

    decline = photo_client.post(
        f"/quiz/photo/games/{game['id']}/no-answer-response?player=2",
        json={
            "accept": False,
            "round_number": round_number,
            "no_answer_offer_version": first_offer_version,
        },
    )
    assert decline.status_code == 200
    declined_game = decline.json()["payload"]["game"]
    assert decline.json()["payload"]["result"] == "no_answer_declined"
    assert declined_game["pending_no_answer_from"] is None
    assert declined_game["pending_no_answer_to"] is None
    assert declined_game["pending_no_answer_offer_version"] is None
    assert declined_game["round_number"] == round_number
    assert declined_game["current_round"]["status"] == "active"
    assert declined_game["latest_completed_round"] is None

    second_offer = photo_client.post(
        f"/quiz/photo/games/{game['id']}/no-answer-offer?player=1",
        json={"round_number": round_number},
    )
    assert second_offer.status_code == 200
    second_offer_game = second_offer.json()["payload"]["game"]
    second_offer_version = second_offer_game["pending_no_answer_offer_version"]
    assert second_offer_version == first_offer_version + 1

    replayed_accept = photo_client.post(
        f"/quiz/photo/games/{game['id']}/no-answer-response?player=2",
        json={
            "accept": True,
            "round_number": round_number,
            "no_answer_offer_version": first_offer_version,
        },
    )
    assert replayed_accept.status_code == 409
    assert replayed_accept.json()["payload"]["code"] == "conflict"

    current_state = photo_client.get(f"/quiz/photo/games/{game['id']}")
    assert current_state.status_code == 200
    current_game = current_state.json()
    assert current_game["pending_no_answer_from"] == 1
    assert current_game["pending_no_answer_to"] == 2
    assert current_game["pending_no_answer_offer_version"] == second_offer_version
    assert current_game["round_number"] == round_number
    assert current_game["current_round"]["status"] == "active"
    assert current_game["latest_completed_round"] is None

    accept = photo_client.post(
        f"/quiz/photo/games/{game['id']}/no-answer-response?player=2",
        json={
            "accept": True,
            "round_number": round_number,
            "no_answer_offer_version": second_offer_version,
        },
    )
    assert accept.status_code == 200
    accepted_game = accept.json()["payload"]["game"]
    assert accept.json()["payload"]["result"] == "no_answer_accepted"
    assert accepted_game["pending_no_answer_from"] is None
    assert accepted_game["pending_no_answer_to"] is None
    assert accepted_game["pending_no_answer_offer_version"] is None
    assert accepted_game["round_number"] == round_number + 1
    assert accepted_game["latest_completed_round"]["round_number"] == round_number
    assert accepted_game["latest_completed_round"]["status"] == "no_answer"
    assert accepted_game["latest_completed_round"]["winner_player"] is None


def test_photo_realtime_adapter_allows_public_no_answer_offer_without_resolving():
    db = _session()
    try:
        for index in range(2):
            _player(
                db,
                "PublicSkip",
                f"Player{index}",
                wikipedia_url=f"https://wiki/public-skip-{index}",
                euroleague_image_url=f"https://cdn/public-skip-{index}.png",
            )
        db.commit()

        game = photo_quiz.create_game(db, target_wins=3, player1_name="A")
        game.is_public = True
        game.preset = "standard"
        photo_quiz.join_game(db, game.join_code, player_name="B", allow_public=True)
        current = photo_quiz._current_round(game)

        outcome = PhotoQuizRealtimeAdapter().handle_client_action(
            db,
            game,
            action="offer_no_answer",
            data={"round_number": current.round_number},
            player=1,
        )

        assert outcome.result == RealtimeResult.NO_ANSWER_OFFERED
        assert game.pending_no_answer_from == 1
        assert game.pending_no_answer_to == 2
        assert game.round_number == current.round_number
        assert current.status == "active"
    finally:
        db.close()


@pytest.mark.asyncio
async def test_photo_disconnect_grace_forfeits_real_quick_match_game(tmp_path: Path):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        for index in range(3):
            _player(
                setup,
                "Disconnect",
                f"Player{index}",
                wikipedia_url=f"https://wiki/disconnect-{index}",
                euroleague_image_url=f"https://cdn/disconnect-{index}.png",
            )
        setup.commit()

        game = photo_quiz.create_game(setup, target_wins=3, player1_name="Host")
        game.is_public = True
        game.preset = "standard"
        photo_quiz.join_game(
            setup,
            game.join_code,
            player_name="Joiner",
            allow_public=True,
        )
        game_id = game.id
        setup.commit()
    finally:
        setup.close()

    grace_sleep = _ControlledSleep()
    module = OnlineGameRealtimeModule(
        PhotoQuizRealtimeAdapter(),
        session_factory=SessionLocal,
        disconnect_grace_seconds=3,
    )
    module.disconnect_grace_timer = DisconnectGraceTimerManager(
        module._expire_disconnect_grace,
        sleep=grace_sleep,
    )
    leaving = _FakeWebSocket()
    opponent = _FakeWebSocket()
    await module.connections.connect(game_id, 1, leaving)
    await module.connections.connect(game_id, 2, opponent)

    module.disconnect(game_id, 1, leaving)
    await grace_sleep.wait_for_call()
    grace_sleep.release()
    await _drain_async_tasks()

    verify = SessionLocal()
    try:
        stored = verify.get(PhotoQuizGame, game_id)
        assert stored.status == "finished"
        assert stored.winner_player == 2
        assert stored.pending_no_answer_from is None
        assert stored.pending_no_answer_to is None
    finally:
        verify.close()

    assert not module.disconnect_grace_timer.has_game_timer(game_id)
    message = opponent.sent[-1]
    RealtimeServerMessageAdapter.validate_python(message)
    assert message["payload"]["result"] == "opponent_left"
    assert message["payload"]["terminal"] is True
    assert message["payload"]["game"]["winner_player"] == 2


@pytest.mark.asyncio
async def test_photo_quick_match_public_round_timeout_auto_skips_with_injected_clock(
    tmp_path: Path,
):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        for index in range(4):
            _player(
                setup,
                "Timer",
                f"Player{index}",
                wikipedia_url=f"https://wiki/timer-{index}",
                euroleague_image_url=f"https://cdn/timer-{index}.png",
            )
        setup.commit()

        game = photo_quiz.create_game(setup, target_wins=3, player1_name="A")
        game.is_public = True
        game.preset = "standard"
        photo_quiz.join_game(setup, game.join_code, player_name="B", allow_public=True)
        game_id = game.id
        setup.commit()
    finally:
        setup.close()

    sleep = _ControlledSleep()
    module = OnlineGameRealtimeModule(
        PhotoQuizRealtimeAdapter(),
        session_factory=SessionLocal,
    )
    module.timer = TurnTimerManager(module._expire_turn, sleep=sleep)
    websocket = _FakeWebSocket()
    await module.connections.connect(game_id, 1, websocket)

    state_db = SessionLocal()
    try:
        state = photo_quiz.serialize_game_state(
            state_db,
            state_db.get(PhotoQuizGame, game_id),
        )
    finally:
        state_db.close()

    module.start_timer_from_state(state)
    await sleep.wait_for_call()
    assert sleep.calls[0][0] == 10

    sleep.release(0)
    await _drain_async_tasks()
    await sleep.wait_for_call(2)
    assert sleep.calls[1][0] > 10
    module.cancel_timer(game_id)

    verify = SessionLocal()
    try:
        stored = verify.get(PhotoQuizGame, game_id)
        assert stored.status == "active"
        assert stored.round_number == 2
        assert stored.player1_score == 0
        assert stored.player2_score == 0
        assert [round_obj.status for round_obj in stored.rounds] == [
            "no_answer",
            "active",
        ]
        latest_completed = photo_quiz.serialize_game_state(
            verify, stored
        )["latest_completed_round"]
        assert latest_completed["status"] == "no_answer"
        assert latest_completed["winner_player"] is None
    finally:
        verify.close()

    message = websocket.sent[-1]
    RealtimeServerMessageAdapter.validate_python(message)
    assert message["payload"]["result"] == "time_expired"
    assert message["payload"]["game"]["latest_completed_round"]["status"] == "no_answer"


@pytest.mark.asyncio
async def test_photo_quick_match_unattended_timeout_finishes_without_rearming(
    tmp_path: Path,
):
    SessionLocal = _file_session_factory(tmp_path)
    setup = SessionLocal()
    try:
        for index in range(3):
            _player(
                setup,
                "Abandoned",
                f"Player{index}",
                wikipedia_url=f"https://wiki/abandoned-{index}",
                euroleague_image_url=f"https://cdn/abandoned-{index}.png",
            )
        setup.commit()

        game = photo_quiz.create_game(setup, target_wins=3, player1_name="A")
        game.is_public = True
        game.preset = "standard"
        photo_quiz.join_game(setup, game.join_code, player_name="B", allow_public=True)
        game_id = game.id
        setup.commit()
    finally:
        setup.close()

    sleep = _ControlledSleep()
    module = OnlineGameRealtimeModule(
        PhotoQuizRealtimeAdapter(),
        session_factory=SessionLocal,
    )
    module.timer = TurnTimerManager(module._expire_turn, sleep=sleep)

    state_db = SessionLocal()
    try:
        state = photo_quiz.serialize_game_state(
            state_db,
            state_db.get(PhotoQuizGame, game_id),
        )
    finally:
        state_db.close()

    module.start_timer_from_state(state)
    await sleep.wait_for_call()
    sleep.release(0)
    await _drain_async_tasks()

    assert len(sleep.calls) == 1
    assert not module.timer.has_timer(game_id)

    verify = SessionLocal()
    try:
        stored = verify.get(PhotoQuizGame, game_id)
        assert stored.status == "finished"
        assert stored.winner_player is None
        assert stored.round_number == 1
        assert stored.player1_score == 0
        assert stored.player2_score == 0
        assert [round_obj.status for round_obj in stored.rounds] == ["no_answer"]
        assert photo_quiz.serialize_game_state(verify, stored)["latest_completed_round"][
            "status"
        ] == "no_answer"
    finally:
        verify.close()


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


def _state_payload(response) -> dict:
    payload = response.json()
    assert payload["type"] == "state"
    return payload["payload"]


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


@pytest.fixture()
def photo_quick_match_effects(monkeypatch):
    effects = {"started": [], "broadcasts": []}

    def fake_start_timer(game_state: dict) -> None:
        effects["started"].append(game_state["id"])

    async def fake_broadcast_state(game_id: int, game_state: dict, **kwargs):
        effects["broadcasts"].append((game_id, game_state, kwargs))
        return 0

    monkeypatch.setattr(
        photo_quiz_router.photo_quiz_realtime,
        "start_timer_from_state",
        fake_start_timer,
    )
    monkeypatch.setattr(
        photo_quiz_router.photo_quiz_realtime,
        "broadcast_state",
        fake_broadcast_state,
    )
    return effects


class _FakeWebSocket:
    def __init__(self):
        self.accepted = False
        self.sent: list[dict] = []

    async def accept(self):
        self.accepted = True

    async def send_json(self, message: dict):
        self.sent.append(message)


class _ControlledSleep:
    def __init__(self):
        self.calls: list[tuple[float, asyncio.Event]] = []

    async def __call__(self, seconds: float):
        release = asyncio.Event()
        self.calls.append((seconds, release))
        await release.wait()

    async def wait_for_call(self, count: int = 1):
        for _ in range(50):
            if len(self.calls) >= count:
                return
            await asyncio.sleep(0)
        raise AssertionError(f"Expected {count} timer sleep call(s), got {len(self.calls)}")

    def release(self, index: int = 0):
        self.calls[index][1].set()


async def _drain_async_tasks(count: int = 5):
    for _ in range(count):
        await asyncio.sleep(0)
