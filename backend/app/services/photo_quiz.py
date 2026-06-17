from __future__ import annotations

import random
import secrets
from datetime import datetime
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.game_actions import (
    ConflictGameActionError,
    InvalidGameActionError,
    NotFoundGameActionError,
)
from app.models import PhotoQuizGame, PhotoQuizGuess, PhotoQuizRound, Player
from app.services.solo_round_token import (
    SoloRoundTokenError,
    create_solo_round_token,
    validate_solo_round_token,
)


PHOTO_QUIZ_DATA_REVISION = "photo-quiz-v1"


def create_solo_round(
    db: Session,
    *,
    recent_player_ids: list[int] | None = None,
) -> dict[str, Any]:
    player = _pick_eligible_player(
        db,
        exclude_ids=set((recent_player_ids or [])[-20:]),
    )
    solo_token_id = _generate_solo_token_id(db)
    game = PhotoQuizGame(
        mode="single_player",
        status="active",
        target_wins=1,
        wrong_guess_visibility="private",
        player1_name="Player 1",
        player1_score=0,
        player2_score=0,
        round_number=1,
    )
    db.add(game)
    db.flush()
    round_obj = PhotoQuizRound(
        game_id=game.id,
        round_number=1,
        status="active",
        answer_player_id=player.id,
        solo_token_id=solo_token_id,
    )
    db.add(round_obj)
    db.flush()
    return {
        "round_token": create_solo_round_token(
            player_id=solo_token_id,
            data_revision=PHOTO_QUIZ_DATA_REVISION,
        ),
        "data_revision": PHOTO_QUIZ_DATA_REVISION,
        "image_url": _resolve_photo_image_url(player),
    }


def submit_solo_guess(db: Session, *, round_token: str, player_id: int) -> dict[str, Any]:
    round_obj = _solo_round_for_token(db, round_token)
    if round_obj.status != "active":
        raise ConflictGameActionError("Photo Quiz round is not active")
    answer_id = round_obj.answer_player_id
    correct = answer_id == player_id
    db.add(
        PhotoQuizGuess(
            round_id=round_obj.id,
            player_number=1,
            guessed_player_id=player_id,
            is_correct=correct,
        )
    )
    if correct:
        round_obj.status = "completed"
        round_obj.winner_player = 1
        round_obj.completed_at = datetime.utcnow()
        round_obj.game.status = "finished"
        round_obj.game.winner_player = 1
        round_obj.game.player1_score = 1
        round_obj.game.updated_at = datetime.utcnow()
    response: dict[str, Any] = {"correct": correct}
    if correct:
        response["answer"] = _player_payload(db, answer_id)
    return response


def reveal_solo_answer(db: Session, *, round_token: str) -> dict[str, Any]:
    round_obj = _solo_round_for_token(db, round_token)
    return {"answer": _player_payload(db, round_obj.answer_player_id)}


def autocomplete_players(
    db: Session,
    *,
    q: str,
    limit: int = 15,
) -> list[dict[str, Any]]:
    query_text = q.strip()
    if not query_text:
        return []

    eligible = _eligible_player_ids_subquery(db)
    query = db.query(Player).filter(Player.id.in_(db.query(eligible.c.player_id)))
    for word in query_text.split():
        pattern = f"%{word}%"
        query = query.filter(
            or_(
                Player.first_name.ilike(pattern),
                Player.last_name.ilike(pattern),
            )
        )

    players = (
        query.order_by(Player.last_name.asc(), Player.first_name.asc())
        .limit(limit)
        .all()
    )
    return [_player_payload(db, player.id) for player in players]


def _pick_eligible_player(db: Session, *, exclude_ids: set[int]) -> Player:
    eligible_ids = _eligible_player_ids(db)
    available_ids = [
        player_id for player_id in eligible_ids if player_id not in exclude_ids
    ]
    if not available_ids:
        available_ids = eligible_ids
    if not available_ids:
        raise ConflictGameActionError("Photo Quiz is not enabled")
    player_id = random.choice(available_ids)
    return db.query(Player).filter_by(id=player_id).one()


def _eligible_player_ids(db: Session) -> list[int]:
    eligible = _eligible_player_ids_subquery(db)
    return [row[0] for row in db.query(eligible.c.player_id).all()]


def _eligible_player_ids_subquery(db: Session):
    has_wikipedia_url = _non_empty_column(Player.wikipedia_url)
    has_euroleague_image = _non_empty_column(Player.euroleague_image_url)
    has_wikipedia_image = _non_empty_column(Player.wikipedia_image_url)
    return (
        db.query(Player.id.label("player_id"))
        .filter(has_wikipedia_url)
        .filter(or_(has_euroleague_image, has_wikipedia_image))
        .subquery()
    )


def _non_empty_column(column):
    return column.is_not(None) & (func.trim(column) != "")


def _resolve_photo_image_url(player: Player) -> str:
    euroleague_url = _clean_url(player.euroleague_image_url)
    if euroleague_url:
        return euroleague_url
    wikipedia_url = _clean_url(player.wikipedia_image_url)
    if wikipedia_url:
        return wikipedia_url
    raise ConflictGameActionError("Photo Quiz player does not have a usable image")


def _clean_url(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _player_payload(db: Session, player_id: int) -> dict[str, Any]:
    player = db.query(Player).filter_by(id=player_id).first()
    if player is None:
        raise NotFoundGameActionError("Player not found")
    return {
        "id": player.id,
        "name": _player_display_name(player),
        "first_name": player.first_name,
        "last_name": player.last_name,
        "nationality": player.nationality,
        "position": player.position,
        "image_url": _resolve_photo_image_url(player),
    }


def _player_display_name(player: Player) -> str:
    return " ".join(
        part for part in [player.first_name, player.last_name] if part
    ).strip()


def _solo_round_for_token(db: Session, round_token: str) -> PhotoQuizRound:
    try:
        payload = validate_solo_round_token(
            round_token,
            current_data_revision=PHOTO_QUIZ_DATA_REVISION,
        )
    except SoloRoundTokenError as exc:
        raise InvalidGameActionError(str(exc)) from exc
    round_obj = (
        db.query(PhotoQuizRound)
        .filter(PhotoQuizRound.solo_token_id == payload.player_id)
        .first()
    )
    if round_obj is None:
        raise InvalidGameActionError("Invalid solo round token")
    return round_obj


def _generate_solo_token_id(db: Session) -> int:
    for _ in range(100):
        token_id = secrets.randbits(63)
        if token_id == 0:
            continue
        exists = (
            db.query(PhotoQuizRound.id)
            .filter(PhotoQuizRound.solo_token_id == token_id)
            .first()
        )
        if exists is None:
            return token_id
    raise ConflictGameActionError("Unable to create Photo Quiz round")
