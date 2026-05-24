from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.game_actions import GameActionError, raise_http_game_action_error, run_http_game_action
from app.schemas.career_quiz import (
    CareerQuizCreateRequest,
    CareerQuizGuessRequest,
    CareerQuizJoinRequest,
    CareerQuizNoAnswerResponseRequest,
    CareerSoloGuessRequest,
    CareerSoloRevealRequest,
    CareerSoloRoundRequest,
)
from app.services import career_quiz as career_service

router = APIRouter()


@router.post("/career/solo/round")
def create_solo_round(payload: CareerSoloRoundRequest, db: Session = Depends(get_db)):
    return run_http_game_action(
        db,
        lambda: career_service.create_solo_round(
            db, recent_player_ids=payload.recent_player_ids
        ),
    )


@router.post("/career/solo/guess")
def submit_solo_guess(payload: CareerSoloGuessRequest, db: Session = Depends(get_db)):
    return run_http_game_action(
        db,
        lambda: career_service.submit_solo_guess(
            db,
            round_token=payload.round_token,
            player_id=payload.player_id,
        ),
    )


@router.post("/career/solo/reveal")
def reveal_solo_answer(payload: CareerSoloRevealRequest, db: Session = Depends(get_db)):
    return run_http_game_action(
        db,
        lambda: career_service.reveal_solo_answer(db, round_token=payload.round_token),
    )


@router.get("/career/players/autocomplete")
def autocomplete_career_players(
    q: str = Query("", min_length=1),
    limit: int = Query(15, ge=1, le=50),
    db: Session = Depends(get_db),
):
    try:
        players = career_service.autocomplete_players(db, q=q, limit=limit)
        return {"query": q, "count": len(players), "players": players}
    except GameActionError as exc:
        raise_http_game_action_error(exc)


@router.post("/career/games")
def create_game(payload: CareerQuizCreateRequest, db: Session = Depends(get_db)):
    game = run_http_game_action(
        db,
        lambda: career_service.create_game(
            db,
            target_wins=payload.target_wins,
            wrong_guess_visibility=payload.wrong_guess_visibility,
            player1_name=payload.player1_name,
        ),
    )
    return career_service.serialize_game_state(db, game)


@router.post("/career/games/join")
def join_game(payload: CareerQuizJoinRequest, db: Session = Depends(get_db)):
    game = run_http_game_action(
        db,
        lambda: career_service.join_game(
            db,
            payload.join_code,
            player_name=payload.player_name,
        ),
    )
    return career_service.serialize_game_state(db, game)


@router.get("/career/games/{game_id}")
def get_game(game_id: int, db: Session = Depends(get_db)):
    try:
        return career_service.serialize_game_state(
            db, career_service.get_game_or_404(db, game_id)
        )
    except GameActionError as exc:
        raise_http_game_action_error(exc)


@router.post("/career/games/{game_id}/guess")
def submit_guess(
    game_id: int,
    payload: CareerQuizGuessRequest,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    def action():
        game = career_service.get_game_or_404(db, game_id)
        previous_round = game.round_number
        result = career_service.submit_guess(
            db,
            game=game,
            player_id=payload.player_id,
            acting_player=player,
        )
        return {
            "result": result,
            "state": career_service.serialize_game_state(db, game),
            "completed_round": career_service.serialize_completed_round(
                db, game.id, previous_round
            )
            if result in {"round_won", "match_won"}
            else None,
        }

    return run_http_game_action(db, action)


@router.post("/career/games/{game_id}/no-answer-offer")
def offer_no_answer(
    game_id: int,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    return run_http_game_action(
        db,
        lambda: _offer_no_answer(db, game_id, player),
    )


@router.post("/career/games/{game_id}/no-answer-response")
def respond_no_answer(
    game_id: int,
    payload: CareerQuizNoAnswerResponseRequest,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    def action():
        game = career_service.get_game_or_404(db, game_id)
        previous_round = game.round_number
        result = career_service.respond_no_answer(
            db,
            game=game,
            acting_player=player,
            accept=payload.accept,
        )
        return {
            "result": f"no_answer_{result}",
            "state": career_service.serialize_game_state(db, game),
            "completed_round": career_service.serialize_completed_round(
                db, game.id, previous_round
            )
            if result == "accepted"
            else None,
        }

    return run_http_game_action(db, action)


def _offer_no_answer(db: Session, game_id: int, player: int):
    game = career_service.get_game_or_404(db, game_id)
    career_service.offer_no_answer(db, game=game, acting_player=player)
    return {
        "result": "no_answer_offered",
        "state": career_service.serialize_game_state(db, game),
    }
