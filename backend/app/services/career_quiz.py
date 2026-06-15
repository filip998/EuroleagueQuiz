from __future__ import annotations

import random
import string
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.game_actions import ConflictGameActionError, InvalidGameActionError, NotFoundGameActionError
from app.models import (
    CareerDataRevision,
    CareerQuizGame,
    CareerQuizGuess,
    CareerQuizRound,
    Player,
    PlayerCareerStint,
    PlayerCareerSourceMapping,
)
from app.services.solo_round_token import (
    SoloRoundTokenError,
    create_solo_round_token,
    validate_solo_round_token,
)


VALID_TARGET_WINS = {1, 3, 5, 7}
VALID_WRONG_GUESS_VISIBILITY = {"private", "shared"}


def create_solo_round(
    db: Session,
    *,
    recent_player_ids: list[int] | None = None,
) -> dict[str, Any]:
    revision = _active_revision(db)
    player = _pick_eligible_player(db, exclude_ids=set((recent_player_ids or [])[-20:]))
    token = create_solo_round_token(
        player_id=player.id,
        data_revision=revision.revision,
    )
    return {
        "round_token": token,
        "data_revision": revision.revision,
        "timeline": _career_timeline(db, player.id),
        "source_note": "Career data from Wikipedia and may be incomplete.",
    }


def submit_solo_guess(db: Session, *, round_token: str, player_id: int) -> dict[str, Any]:
    answer_id = _validate_solo_answer_id(db, round_token)
    correct = answer_id == player_id
    response: dict[str, Any] = {"correct": correct}
    if correct:
        response["answer"] = _player_payload(db, answer_id)
    return response


def reveal_solo_answer(db: Session, *, round_token: str) -> dict[str, Any]:
    answer_id = _validate_solo_answer_id(db, round_token)
    return {"answer": _player_payload(db, answer_id)}


def autocomplete_players(db: Session, *, q: str, limit: int = 15) -> list[dict[str, Any]]:
    query = q.strip().lower()
    if not query:
        return []
    eligible = _eligible_player_ids_subquery(db)
    rows = (
        db.query(Player)
        .filter(Player.id.in_(db.query(eligible.c.player_id)))
        .filter(
            func.lower(
                func.coalesce(Player.first_name, "") + " " + func.coalesce(Player.last_name, "")
            ).contains(query)
        )
        .order_by(Player.last_name, Player.first_name)
        .limit(limit)
        .all()
    )
    return [_player_payload(db, player.id) for player in rows]


def create_game(
    db: Session,
    *,
    target_wins: int = 3,
    wrong_guess_visibility: str = "private",
    player1_name: str | None = None,
) -> CareerQuizGame:
    _active_revision(db)
    if target_wins not in VALID_TARGET_WINS:
        raise InvalidGameActionError("Invalid target_wins")
    if wrong_guess_visibility not in VALID_WRONG_GUESS_VISIBILITY:
        raise InvalidGameActionError("Invalid wrong_guess_visibility")
    game = CareerQuizGame(
        mode="online_friend",
        status="waiting_for_opponent",
        join_code=_generate_join_code(db),
        target_wins=target_wins,
        wrong_guess_visibility=wrong_guess_visibility,
        player1_name=player1_name or "Player 1",
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
) -> CareerQuizGame:
    game = (
        db.query(CareerQuizGame)
        .filter(CareerQuizGame.join_code == join_code.upper())
        .first()
    )
    if game is None:
        raise NotFoundGameActionError("Game not found")
    if game.status != "waiting_for_opponent":
        raise ConflictGameActionError("Game is not waiting for an opponent")
    game.player2_name = player_name or "Player 2"
    game.status = "active"
    _create_next_round(db, game)
    return game


def get_game_or_404(db: Session, game_id: int) -> CareerQuizGame:
    game = db.query(CareerQuizGame).filter_by(id=game_id).first()
    if game is None:
        raise NotFoundGameActionError("Game not found")
    return game


def submit_guess(
    db: Session,
    *,
    game: CareerQuizGame,
    player_id: int,
    acting_player: int,
) -> str:
    if acting_player not in (1, 2):
        raise InvalidGameActionError("Player identity is required")
    if game.status != "active":
        raise ConflictGameActionError("Game is not active")
    round_obj = _current_round(game)
    if round_obj.status != "active":
        raise ConflictGameActionError("Round is not active")

    correct = player_id == round_obj.answer_player_id
    db.add(
        CareerQuizGuess(
            round_id=round_obj.id,
            player_number=acting_player,
            guessed_player_id=player_id,
            is_correct=correct,
        )
    )
    if not correct:
        return "incorrect"

    round_obj.status = "completed"
    round_obj.winner_player = acting_player
    round_obj.completed_at = datetime.utcnow()
    if acting_player == 1:
        game.player1_score += 1
    else:
        game.player2_score += 1
    game.pending_no_answer_from = None
    game.pending_no_answer_to = None

    if game.player1_score >= game.target_wins or game.player2_score >= game.target_wins:
        game.status = "finished"
        game.winner_player = acting_player
        return "match_won"

    game.round_number += 1
    _create_next_round(db, game)
    return "round_won"


def offer_no_answer(
    db: Session,
    *,
    game: CareerQuizGame,
    acting_player: int,
) -> None:
    if acting_player not in (1, 2):
        raise InvalidGameActionError("Player identity is required")
    if game.status != "active":
        raise ConflictGameActionError("Game is not active")
    game.pending_no_answer_from = acting_player
    game.pending_no_answer_to = 2 if acting_player == 1 else 1


def respond_no_answer(
    db: Session,
    *,
    game: CareerQuizGame,
    acting_player: int,
    accept: bool,
) -> str:
    if acting_player != game.pending_no_answer_to:
        raise InvalidGameActionError("No answer offer is not pending for this player")
    if not accept:
        game.pending_no_answer_from = None
        game.pending_no_answer_to = None
        return "declined"

    round_obj = _current_round(game)
    round_obj.status = "no_answer"
    round_obj.completed_at = datetime.utcnow()
    game.pending_no_answer_from = None
    game.pending_no_answer_to = None
    game.round_number += 1
    _create_next_round(db, game)
    return "accepted"


def serialize_game_state(db: Session, game: CareerQuizGame) -> dict[str, Any]:
    current_round = None
    if game.status == "active":
        current_round = _round_payload(db, _current_round(game), include_answer=False)
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
        db.query(CareerQuizRound)
        .filter_by(game_id=game_id, round_number=round_number)
        .first()
    )
    if round_obj is None:
        return None
    return _round_payload(db, round_obj, include_answer=True)


def _latest_completed_round_payload(
    db: Session, game: CareerQuizGame
) -> dict[str, Any] | None:
    round_obj = (
        db.query(CareerQuizRound)
        .filter(CareerQuizRound.game_id == game.id)
        .filter(CareerQuizRound.status.in_(("completed", "no_answer")))
        .order_by(CareerQuizRound.round_number.desc())
        .first()
    )
    if round_obj is None:
        return None
    return _round_payload(db, round_obj, include_answer=True)


def _round_payload(
    db: Session,
    round_obj: CareerQuizRound,
    *,
    include_answer: bool,
) -> dict[str, Any]:
    payload = {
        "round_number": round_obj.round_number,
        "status": round_obj.status,
        "winner_player": round_obj.winner_player,
        "timeline": _career_timeline(db, round_obj.answer_player_id),
        "resolved_at": _utc_isoformat(round_obj.completed_at),
    }
    if include_answer:
        payload["answer"] = _player_payload(db, round_obj.answer_player_id)
    return payload


def _utc_isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat()


def _current_round(game: CareerQuizGame) -> CareerQuizRound:
    for round_obj in game.rounds:
        if round_obj.round_number == game.round_number:
            return round_obj
    raise ConflictGameActionError("Current round not found")


def _create_next_round(db: Session, game: CareerQuizGame) -> CareerQuizRound:
    previous_answers = {round_obj.answer_player_id for round_obj in game.rounds}
    player = _pick_eligible_player(db, exclude_ids=previous_answers)
    round_obj = CareerQuizRound(
        round_number=game.round_number,
        status="active",
        answer_player_id=player.id,
    )
    game.rounds.append(round_obj)
    db.flush()
    return round_obj


def _pick_eligible_player(db: Session, *, exclude_ids: set[int]) -> Player:
    eligible_ids = _eligible_player_ids(db)
    available_ids = [player_id for player_id in eligible_ids if player_id not in exclude_ids]
    if not available_ids:
        available_ids = eligible_ids
    if not available_ids:
        raise ConflictGameActionError("Career Quiz is not enabled")
    player_id = random.choice(available_ids)
    return db.query(Player).filter_by(id=player_id).one()


def _eligible_player_ids(db: Session) -> list[int]:
    eligible = _eligible_player_ids_subquery(db)
    return [row[0] for row in db.query(eligible.c.player_id).all()]


def _eligible_player_ids_subquery(db: Session):
    return (
        db.query(PlayerCareerStint.player_id)
        .join(
            PlayerCareerSourceMapping,
            PlayerCareerSourceMapping.player_id == PlayerCareerStint.player_id,
        )
        .filter(PlayerCareerSourceMapping.status == "accepted")
        .filter(PlayerCareerStint.include_in_quiz.is_(True))
        .group_by(PlayerCareerStint.player_id)
        .having(func.count(PlayerCareerStint.id) >= 3)
        .subquery()
    )


def _career_timeline(db: Session, player_id: int) -> list[dict[str, Any]]:
    stints = (
        db.query(PlayerCareerStint)
        .filter_by(player_id=player_id, include_in_quiz=True)
        .order_by(PlayerCareerStint.sequence_index)
        .all()
    )
    return [
        {
            "team_name": stint.source_team_label,
            "years": _format_years(stint),
            "start_season": stint.start_season,
            "end_season": _display_end_season(stint),
            "is_current": stint.is_current,
            "is_loan": stint.is_loan,
            "source_url": stint.source_team_url,
        }
        for stint in stints
    ]


def _format_years(stint: PlayerCareerStint) -> str | None:
    start = stint.raw_start or (
        str(stint.start_season_year) if stint.start_season_year is not None else None
    )
    if not start:
        return None
    if stint.is_current or not stint.raw_end:
        return f"{start}\u2013present"
    if stint.raw_end == start:
        return start
    return f"{start}\u2013{stint.raw_end}"


def _display_end_season(stint: PlayerCareerStint) -> str | None:
    if (
        stint.start_season_year is not None
        and stint.end_season_year is not None
        and stint.end_season_year < stint.start_season_year
    ):
        return stint.start_season
    return stint.end_season


def _player_payload(db: Session, player_id: int) -> dict[str, Any]:
    player = db.query(Player).filter_by(id=player_id).first()
    if player is None:
        raise NotFoundGameActionError("Player not found")
    return {
        "id": player.id,
        "name": " ".join(
            part for part in [player.first_name, player.last_name] if part
        ).strip(),
        "first_name": player.first_name,
        "last_name": player.last_name,
        "nationality": player.nationality,
        "position": player.position,
        "image_url": player.image_url,
    }


def _active_revision(db: Session) -> CareerDataRevision:
    revision = (
        db.query(CareerDataRevision)
        .filter_by(is_active=True, threshold_passed=True)
        .filter(CareerDataRevision.threshold_player_count >= settings.career_quiz_min_eligible_players)
        .filter(CareerDataRevision.eligible_player_count >= settings.career_quiz_min_eligible_players)
        .order_by(CareerDataRevision.created_at.desc())
        .first()
    )
    if revision is None:
        raise ConflictGameActionError("Career Quiz is not enabled")
    return revision


def _validate_solo_answer_id(db: Session, round_token: str) -> int:
    revision = _active_revision(db)
    try:
        payload = validate_solo_round_token(
            round_token,
            current_data_revision=revision.revision,
        )
    except SoloRoundTokenError as exc:
        raise InvalidGameActionError(str(exc)) from exc
    return payload.player_id


def _generate_join_code(db: Session) -> str:
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = "".join(random.choice(alphabet) for _ in range(6))
        exists = db.query(CareerQuizGame).filter_by(join_code=code).first()
        if not exists:
            return code
