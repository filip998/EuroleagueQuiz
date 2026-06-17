from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.game_actions import (
    GameActionError,
    raise_http_game_action_error,
    run_http_game_action,
)
from app.schemas.photo_quiz import (
    PhotoSoloGuessRequest,
    PhotoSoloRevealRequest,
    PhotoSoloRoundRequest,
)
from app.services import photo_quiz as photo_service

router = APIRouter()


@router.post("/photo/solo/round")
def create_solo_round(payload: PhotoSoloRoundRequest, db: Session = Depends(get_db)):
    return run_http_game_action(
        db,
        lambda: photo_service.create_solo_round(
            db, recent_player_ids=payload.recent_player_ids
        ),
    )


@router.post("/photo/solo/guess")
def submit_solo_guess(payload: PhotoSoloGuessRequest, db: Session = Depends(get_db)):
    return run_http_game_action(
        db,
        lambda: photo_service.submit_solo_guess(
            db,
            round_token=payload.round_token,
            player_id=payload.player_id,
        ),
    )


@router.post("/photo/solo/reveal")
def reveal_solo_answer(payload: PhotoSoloRevealRequest, db: Session = Depends(get_db)):
    return run_http_game_action(
        db,
        lambda: photo_service.reveal_solo_answer(db, round_token=payload.round_token),
    )


@router.get("/photo/players/autocomplete")
def autocomplete_photo_players(
    q: str = Query("", min_length=1),
    limit: int = Query(15, ge=1, le=50),
    db: Session = Depends(get_db),
):
    try:
        players = photo_service.autocomplete_players(db, q=q, limit=limit)
        return {"query": q, "count": len(players), "players": players}
    except GameActionError as exc:
        raise_http_game_action_error(exc)
