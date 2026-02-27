"""Higher or Lower API router."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas.higher_lower import (
    HigherLowerAnswerRequest,
    HigherLowerAnswerResponse,
    HigherLowerCreateRequest,
    HigherLowerCreateResponse,
    LeaderboardResponse,
)
from app.services.higher_lower import (
    create_game,
    get_leaderboard,
    submit_answer,
)

router = APIRouter()


@router.post("/higher-lower/games", response_model=HigherLowerCreateResponse)
def create_higher_lower_game(req: HigherLowerCreateRequest, db: Session = Depends(get_db)):
    if req.season_range_start > req.season_range_end:
        raise HTTPException(status_code=400, detail="season_range_start must be <= season_range_end")
    try:
        result = create_game(
            db,
            tier=req.tier,
            season_range_start=req.season_range_start,
            season_range_end=req.season_range_end,
            nickname=req.nickname,
        )
        db.commit()
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/higher-lower/games/{game_id}/answer", response_model=HigherLowerAnswerResponse)
def answer_higher_lower(game_id: int, req: HigherLowerAnswerRequest, db: Session = Depends(get_db)):
    try:
        result = submit_answer(db, game_id, choice=req.choice)
        db.commit()
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/higher-lower/leaderboard/{tier}", response_model=LeaderboardResponse)
def higher_lower_leaderboard(tier: str, db: Session = Depends(get_db)):
    if tier not in ("easy", "medium", "hard"):
        raise HTTPException(status_code=400, detail="Invalid tier")
    entries = get_leaderboard(db, tier)
    return {"tier": tier, "entries": entries}
