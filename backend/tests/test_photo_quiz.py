import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.game_actions import ConflictGameActionError, InvalidGameActionError
from app.models import Player
from app.services import photo_quiz
from app.services.solo_round_token import create_solo_round_token


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


def test_solo_guess_and_reveal_hide_answer_until_correct_or_revealed():
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

        token = create_solo_round_token(
            player_id=answer.id,
            data_revision=photo_quiz.PHOTO_QUIZ_DATA_REVISION,
        )

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


def _session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


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
