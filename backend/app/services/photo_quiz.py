from __future__ import annotations

import random
import secrets
import string
from datetime import datetime, timedelta, timezone
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
VALID_TARGET_WINS = {1, 3, 5, 7}
VALID_WRONG_GUESS_VISIBILITY = {"private", "shared"}
PHOTO_REVEAL_COUNTDOWN_SECONDS = 3
GUEST_ID_MAX_LENGTH = 64


def _clean_guest_id(guest_id: str | None) -> str | None:
    if not guest_id:
        return None
    cleaned = guest_id.strip()[:GUEST_ID_MAX_LENGTH]
    return cleaned or None


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


def create_game(
    db: Session,
    *,
    target_wins: int = 3,
    wrong_guess_visibility: str = "private",
    player1_name: str | None = None,
    guest_id: str | None = None,
) -> PhotoQuizGame:
    if target_wins not in VALID_TARGET_WINS:
        raise InvalidGameActionError("Invalid target_wins")
    if wrong_guess_visibility not in VALID_WRONG_GUESS_VISIBILITY:
        raise InvalidGameActionError("Invalid wrong_guess_visibility")
    if not _eligible_player_ids(db):
        raise ConflictGameActionError("Photo Quiz is not enabled")

    game = PhotoQuizGame(
        mode="online_friend",
        status="waiting_for_opponent",
        join_code=_generate_join_code(db),
        target_wins=target_wins,
        wrong_guess_visibility=wrong_guess_visibility,
        player1_name=player1_name or "Player 1",
        player1_guest_id=_clean_guest_id(guest_id),
        player1_score=0,
        player2_score=0,
        round_number=1,
    )
    db.add(game)
    db.flush()
    return game


def join_game(
    db: Session,
    join_code: str,
    *,
    player_name: str | None = None,
    guest_id: str | None = None,
) -> PhotoQuizGame:
    game = (
        db.query(PhotoQuizGame)
        .filter(PhotoQuizGame.join_code == join_code.upper())
        .first()
    )
    if game is None:
        raise NotFoundGameActionError("Game not found")
    if game.status != "waiting_for_opponent":
        raise ConflictGameActionError("Game is not waiting for an opponent")
    joined_at = datetime.utcnow()
    updated = (
        db.query(PhotoQuizGame)
        .filter(PhotoQuizGame.id == game.id)
        .filter(PhotoQuizGame.status == "waiting_for_opponent")
        .update(
            {
                "player2_name": player_name or "Player 2",
                "player2_guest_id": _clean_guest_id(guest_id)
                or game.player2_guest_id,
                "status": "active",
                "updated_at": joined_at,
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        raise ConflictGameActionError("Game is not waiting for an opponent")
    game.player2_name = player_name or "Player 2"
    game.player2_guest_id = _clean_guest_id(guest_id) or game.player2_guest_id
    game.status = "active"
    game.updated_at = joined_at
    _create_next_round(db, game)
    return game


def get_game_or_404(db: Session, game_id: int) -> PhotoQuizGame:
    game = db.query(PhotoQuizGame).filter_by(id=game_id).first()
    if game is None:
        raise NotFoundGameActionError("Game not found")
    return game


def submit_guess(
    db: Session,
    *,
    game: PhotoQuizGame,
    player_id: int,
    acting_player: int,
    round_number: int,
) -> str:
    if acting_player not in (1, 2):
        raise InvalidGameActionError("Player identity is required")
    if game.status != "active":
        raise ConflictGameActionError("Game is not active")
    _raise_if_round_stale(game, round_number)
    round_obj = _current_round(game)
    if round_obj.status != "active":
        raise ConflictGameActionError("Round is not active")
    _raise_if_current_round_locked(game)
    _assert_active_game_round(db, game, round_obj, round_number)
    if db.query(Player.id).filter_by(id=player_id).first() is None:
        raise NotFoundGameActionError("Player not found")

    correct = player_id == round_obj.answer_player_id
    if correct:
        completed_at = datetime.utcnow()
        _claim_active_round(
            db,
            round_obj,
            status="completed",
            winner_player=acting_player,
            completed_at=completed_at,
        )
    else:
        _guard_active_round_for_guess(db, game, round_obj, round_number)
    db.add(
        PhotoQuizGuess(
            round_id=round_obj.id,
            player_number=acting_player,
            guessed_player_id=player_id,
            is_correct=correct,
        )
    )
    if not correct:
        return "incorrect"

    player1_score = game.player1_score + (1 if acting_player == 1 else 0)
    player2_score = game.player2_score + (1 if acting_player == 2 else 0)
    match_won = player1_score >= game.target_wins or player2_score >= game.target_wins
    game_values: dict[str, Any] = {
        "player1_score": player1_score,
        "player2_score": player2_score,
        "pending_no_answer_from": None,
        "pending_no_answer_to": None,
    }
    if match_won:
        game_values["status"] = "finished"
        game_values["winner_player"] = acting_player
    else:
        game_values["round_number"] = game.round_number + 1
    _update_active_game_round(db, game, round_number, game_values)

    game.player1_score = player1_score
    game.player2_score = player2_score
    game.pending_no_answer_from = None
    game.pending_no_answer_to = None

    if match_won:
        return "match_won"

    _create_next_round(db, game)
    return "round_won"


def offer_no_answer(
    db: Session,
    *,
    game: PhotoQuizGame,
    acting_player: int,
    round_number: int,
) -> None:
    if acting_player not in (1, 2):
        raise InvalidGameActionError("Player identity is required")
    if game.status != "active":
        raise ConflictGameActionError("Game is not active")
    _raise_if_round_stale(game, round_number)
    _raise_if_current_round_locked(game)
    _assert_active_game_round(db, game, _current_round(game), round_number)
    pending_to = 2 if acting_player == 1 else 1
    _create_pending_no_answer_offer(
        db,
        game,
        round_number,
        acting_player=acting_player,
        pending_to=pending_to,
    )
    game.pending_no_answer_from = acting_player
    game.pending_no_answer_to = pending_to


def respond_no_answer(
    db: Session,
    *,
    game: PhotoQuizGame,
    acting_player: int,
    accept: bool,
    round_number: int,
) -> str:
    if acting_player not in (1, 2):
        raise InvalidGameActionError("Player identity is required")
    if game.status != "active":
        raise ConflictGameActionError("Game is not active")
    _raise_if_round_stale(game, round_number)
    if acting_player != game.pending_no_answer_to:
        raise InvalidGameActionError("No answer offer is not pending for this player")
    if accept:
        _raise_if_current_round_locked(game)
    if not accept:
        _update_pending_no_answer_offer(
            db,
            game,
            round_number,
            acting_player=acting_player,
            values={
                "pending_no_answer_from": None,
                "pending_no_answer_to": None,
            },
        )
        game.pending_no_answer_from = None
        game.pending_no_answer_to = None
        return "declined"

    round_obj = _current_round(game)
    completed_at = datetime.utcnow()
    _claim_active_round(
        db,
        round_obj,
        status="no_answer",
        winner_player=None,
        completed_at=completed_at,
    )
    _update_pending_no_answer_offer(
        db,
        game,
        round_number,
        acting_player=acting_player,
        values={
            "pending_no_answer_from": None,
            "pending_no_answer_to": None,
            "round_number": game.round_number + 1,
        },
    )
    game.pending_no_answer_from = None
    game.pending_no_answer_to = None
    _create_next_round(db, game)
    return "accepted"


def serialize_game_state(db: Session, game: PhotoQuizGame) -> dict[str, Any]:
    current_round = None
    if game.status == "active":
        current_round_obj = _current_round(game)
        current_round = _round_payload(db, current_round_obj, include_answer=False)
        if game.wrong_guess_visibility == "shared":
            current_round["wrong_guesses"] = _wrong_guess_payloads(db, current_round_obj)
    latest_completed_round = _latest_completed_round_payload(db, game)
    return {
        "id": game.id,
        "mode": game.mode,
        "status": game.status,
        "join_code": game.join_code,
        "target_wins": game.target_wins,
        "wrong_guess_visibility": game.wrong_guess_visibility,
        "player1_name": game.player1_name,
        "player2_name": game.player2_name,
        "player1_score": game.player1_score,
        "player2_score": game.player2_score,
        "round_number": game.round_number,
        "winner_player": game.winner_player,
        "pending_no_answer_from": game.pending_no_answer_from,
        "pending_no_answer_to": game.pending_no_answer_to,
        "current_round": current_round,
        "latest_completed_round": latest_completed_round,
    }


def serialize_completed_round(
    db: Session, game_id: int, round_number: int
) -> dict[str, Any] | None:
    round_obj = (
        db.query(PhotoQuizRound)
        .filter_by(game_id=game_id, round_number=round_number)
        .first()
    )
    if round_obj is None:
        return None
    return _round_payload(db, round_obj, include_answer=True)


def _latest_completed_round_payload(
    db: Session, game: PhotoQuizGame
) -> dict[str, Any] | None:
    round_obj = (
        db.query(PhotoQuizRound)
        .filter(PhotoQuizRound.game_id == game.id)
        .filter(PhotoQuizRound.status.in_(("completed", "no_answer")))
        .order_by(PhotoQuizRound.round_number.desc())
        .first()
    )
    if round_obj is None:
        return None
    payload = _round_payload(db, round_obj, include_answer=True)
    next_round_starts_at = _active_next_round_lock_starts_at(game)
    if next_round_starts_at is not None and round_obj.round_number == game.round_number - 1:
        payload["next_round_starts_at"] = _utc_isoformat(next_round_starts_at)
    return payload


def _round_payload(
    db: Session,
    round_obj: PhotoQuizRound,
    *,
    include_answer: bool,
) -> dict[str, Any]:
    payload = {
        "round_number": round_obj.round_number,
        "status": round_obj.status,
        "winner_player": round_obj.winner_player,
        "image_url": _resolve_photo_image_url(round_obj.answer_player),
        "resolved_at": _utc_isoformat(round_obj.completed_at),
        "next_round_starts_at": None,
    }
    if include_answer:
        payload["answer"] = _player_payload(db, round_obj.answer_player_id)
    return payload


def _wrong_guess_payloads(
    db: Session, round_obj: PhotoQuizRound
) -> list[dict[str, Any]]:
    guesses = (
        db.query(PhotoQuizGuess)
        .filter(PhotoQuizGuess.round_id == round_obj.id)
        .filter(PhotoQuizGuess.is_correct.is_(False))
        .order_by(PhotoQuizGuess.created_at, PhotoQuizGuess.id)
        .all()
    )
    return [
        {
            "player_number": guess.player_number,
            "player": _wrong_guess_player_payload(guess.guessed_player),
        }
        for guess in guesses
    ]


def _utc_isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _as_utc(value).isoformat()


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _raise_if_current_round_locked(game: PhotoQuizGame) -> None:
    if _active_next_round_lock_starts_at(game) is not None:
        raise ConflictGameActionError("round_locked")


def _raise_if_round_stale(game: PhotoQuizGame, round_number: int) -> None:
    if round_number != game.round_number:
        raise ConflictGameActionError("round_stale")


def _active_next_round_lock_starts_at(
    game: PhotoQuizGame, *, now: datetime | None = None
) -> datetime | None:
    if game.status != "active":
        return None
    current_round = _current_round(game)
    if current_round.status != "active":
        return None
    previous_round = _previous_completed_round_for_current(game)
    if previous_round is None:
        return None
    starts_at = _round_next_starts_at(previous_round)
    if starts_at is None:
        return None
    now_utc = _as_utc(now or datetime.now(timezone.utc))
    return starts_at if now_utc < starts_at else None


def _previous_completed_round_for_current(
    game: PhotoQuizGame,
) -> PhotoQuizRound | None:
    previous_round_number = game.round_number - 1
    if previous_round_number < 1:
        return None
    for round_obj in game.rounds:
        if (
            round_obj.round_number == previous_round_number
            and round_obj.status in ("completed", "no_answer")
        ):
            return round_obj
    return None


def _round_next_starts_at(round_obj: PhotoQuizRound) -> datetime | None:
    if round_obj.completed_at is None:
        return None
    return _as_utc(round_obj.completed_at) + timedelta(
        seconds=PHOTO_REVEAL_COUNTDOWN_SECONDS
    )


def _assert_active_game_round(
    db: Session,
    game: PhotoQuizGame,
    round_obj: PhotoQuizRound,
    round_number: int,
) -> None:
    exists = (
        db.query(PhotoQuizRound.id)
        .join(PhotoQuizGame, PhotoQuizGame.id == PhotoQuizRound.game_id)
        .filter(PhotoQuizRound.id == round_obj.id)
        .filter(PhotoQuizRound.status == "active")
        .filter(PhotoQuizGame.id == game.id)
        .filter(PhotoQuizGame.status == "active")
        .filter(PhotoQuizGame.round_number == round_number)
        .first()
    )
    if exists is None:
        raise ConflictGameActionError("round_stale")


def _claim_active_round(
    db: Session,
    round_obj: PhotoQuizRound,
    *,
    status: str,
    winner_player: int | None,
    completed_at: datetime,
) -> None:
    updated = (
        db.query(PhotoQuizRound)
        .filter(PhotoQuizRound.id == round_obj.id)
        .filter(PhotoQuizRound.status == "active")
        .update(
            {
                "status": status,
                "winner_player": winner_player,
                "completed_at": completed_at,
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        raise ConflictGameActionError("round_stale")
    round_obj.status = status
    round_obj.winner_player = winner_player
    round_obj.completed_at = completed_at


def _guard_active_round_for_guess(
    db: Session,
    game: PhotoQuizGame,
    round_obj: PhotoQuizRound,
    round_number: int,
) -> None:
    updated = (
        db.query(PhotoQuizRound)
        .filter(PhotoQuizRound.id == round_obj.id)
        .filter(PhotoQuizRound.status == "active")
        .filter(
            PhotoQuizRound.game.has(
                (PhotoQuizGame.id == game.id)
                & (PhotoQuizGame.status == "active")
                & (PhotoQuizGame.round_number == round_number)
            )
        )
        .update({"status": "active"}, synchronize_session=False)
    )
    if updated != 1:
        raise ConflictGameActionError("round_stale")


def _update_active_game_round(
    db: Session,
    game: PhotoQuizGame,
    round_number: int,
    values: dict[str, Any],
) -> None:
    update_values = dict(values)
    update_values.setdefault("updated_at", datetime.utcnow())
    updated = (
        db.query(PhotoQuizGame)
        .filter(PhotoQuizGame.id == game.id)
        .filter(PhotoQuizGame.status == "active")
        .filter(PhotoQuizGame.round_number == round_number)
        .update(update_values, synchronize_session=False)
    )
    if updated != 1:
        raise ConflictGameActionError("round_stale")
    for key, value in update_values.items():
        setattr(game, key, value)


def _create_pending_no_answer_offer(
    db: Session,
    game: PhotoQuizGame,
    round_number: int,
    *,
    acting_player: int,
    pending_to: int,
) -> None:
    updated_at = datetime.utcnow()
    updated = (
        db.query(PhotoQuizGame)
        .filter(PhotoQuizGame.id == game.id)
        .filter(PhotoQuizGame.status == "active")
        .filter(PhotoQuizGame.round_number == round_number)
        .filter(PhotoQuizGame.pending_no_answer_from.is_(None))
        .filter(PhotoQuizGame.pending_no_answer_to.is_(None))
        .update(
            {
                "pending_no_answer_from": acting_player,
                "pending_no_answer_to": pending_to,
                "updated_at": updated_at,
            },
            synchronize_session=False,
        )
    )
    if updated != 1:
        current = (
            db.query(PhotoQuizGame.status, PhotoQuizGame.round_number)
            .filter(PhotoQuizGame.id == game.id)
            .first()
        )
        if (
            current is None
            or current.status != "active"
            or current.round_number != round_number
        ):
            raise ConflictGameActionError("round_stale")
        raise ConflictGameActionError("No answer offer is already pending")
    game.pending_no_answer_from = acting_player
    game.pending_no_answer_to = pending_to
    game.updated_at = updated_at


def _update_pending_no_answer_offer(
    db: Session,
    game: PhotoQuizGame,
    round_number: int,
    *,
    acting_player: int,
    values: dict[str, Any],
) -> None:
    expected_from = 2 if acting_player == 1 else 1
    expected_updated_at = game.updated_at
    update_values = dict(values)
    update_values.setdefault("updated_at", datetime.utcnow())
    updated = (
        db.query(PhotoQuizGame)
        .filter(PhotoQuizGame.id == game.id)
        .filter(PhotoQuizGame.status == "active")
        .filter(PhotoQuizGame.round_number == round_number)
        .filter(PhotoQuizGame.updated_at == expected_updated_at)
        .filter(PhotoQuizGame.pending_no_answer_from == expected_from)
        .filter(PhotoQuizGame.pending_no_answer_to == acting_player)
        .update(update_values, synchronize_session=False)
    )
    if updated != 1:
        current = (
            db.query(PhotoQuizGame.status, PhotoQuizGame.round_number)
            .filter(PhotoQuizGame.id == game.id)
            .first()
        )
        if (
            current is None
            or current.status != "active"
            or current.round_number != round_number
        ):
            raise ConflictGameActionError("round_stale")
        raise ConflictGameActionError("No answer offer is not pending for this player")
    for key, value in update_values.items():
        setattr(game, key, value)


def _current_round(game: PhotoQuizGame) -> PhotoQuizRound:
    for round_obj in game.rounds:
        if round_obj.round_number == game.round_number:
            return round_obj
    raise ConflictGameActionError("Current round not found")


def _create_next_round(db: Session, game: PhotoQuizGame) -> PhotoQuizRound:
    previous_answers = {round_obj.answer_player_id for round_obj in game.rounds}
    player = _pick_eligible_player(db, exclude_ids=previous_answers)
    round_obj = PhotoQuizRound(
        round_number=game.round_number,
        status="active",
        answer_player_id=player.id,
    )
    game.rounds.append(round_obj)
    db.flush()
    return round_obj


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


def _wrong_guess_player_payload(player: Player) -> dict[str, Any]:
    return {
        "id": player.id,
        "name": _player_display_name(player),
        "image_url": _nullable_photo_image_url(player),
    }


def _nullable_photo_image_url(player: Player) -> str | None:
    return _clean_url(player.euroleague_image_url) or _clean_url(
        player.wikipedia_image_url
    )


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


def _generate_join_code(db: Session) -> str:
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = "".join(random.choice(alphabet) for _ in range(6))
        exists = db.query(PhotoQuizGame).filter_by(join_code=code).first()
        if not exists:
            return code
