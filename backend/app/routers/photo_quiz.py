from fastapi import APIRouter, Depends, Query, WebSocket
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.game_actions import (
    GameActionError,
    raise_http_game_action_error,
    run_http_game_action,
)
from app.schemas.photo_quiz import (
    PhotoQuizCreateRequest,
    PhotoQuizGuessRequest,
    PhotoQuizJoinRequest,
    PhotoQuizNoAnswerOfferRequest,
    PhotoQuizNoAnswerResponseRequest,
    PhotoSoloGuessRequest,
    PhotoSoloRevealRequest,
    PhotoSoloRoundRequest,
)
from app.services import photo_quiz as photo_service
from app.services.game_action_orchestration import (
    GameActionName,
    HttpGameActionRejected,
)
from app.services.realtime import OnlineGameRealtimeModule
from app.services.realtime_adapters import PhotoQuizRealtimeAdapter

router = APIRouter()
photo_quiz_realtime = OnlineGameRealtimeModule(PhotoQuizRealtimeAdapter())


async def _photo_quiz_http_action(
    db: Session,
    action: GameActionName,
    *,
    payload=None,
    game_id: int | None = None,
    player: int | None = None,
):
    try:
        return await photo_quiz_realtime.game_actions.http_action(
            db=db,
            action=action,
            payload=payload,
            game_id=game_id,
            player=player,
        )
    except HttpGameActionRejected as exc:
        return JSONResponse(status_code=exc.status_code, content=exc.envelope)


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


@router.post("/photo/games")
async def create_game(payload: PhotoQuizCreateRequest, db: Session = Depends(get_db)):
    return await _photo_quiz_http_action(
        db,
        GameActionName.CREATE,
        payload=payload,
    )


@router.post("/photo/games/join")
async def join_game(payload: PhotoQuizJoinRequest, db: Session = Depends(get_db)):
    return await _photo_quiz_http_action(
        db,
        GameActionName.JOIN,
        payload=payload,
    )


@router.get("/photo/games/{game_id}")
def get_game(game_id: int, db: Session = Depends(get_db)):
    try:
        return photo_service.serialize_game_state(
            db, photo_service.get_game_or_404(db, game_id)
        )
    except GameActionError as exc:
        raise_http_game_action_error(exc)


@router.post("/photo/games/{game_id}/guess")
async def submit_guess(
    game_id: int,
    payload: PhotoQuizGuessRequest,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    return await _photo_quiz_http_action(
        db,
        GameActionName.GUESS,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/photo/games/{game_id}/no-answer-offer")
async def offer_no_answer(
    game_id: int,
    payload: PhotoQuizNoAnswerOfferRequest,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    return await _photo_quiz_http_action(
        db,
        GameActionName.OFFER_NO_ANSWER,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/photo/games/{game_id}/no-answer-response")
async def respond_no_answer(
    game_id: int,
    payload: PhotoQuizNoAnswerResponseRequest,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    return await _photo_quiz_http_action(
        db,
        GameActionName.RESPOND_NO_ANSWER,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.websocket("/photo/ws/{game_id}")
async def photo_quiz_websocket(websocket: WebSocket, game_id: int, player: int = 1):
    await photo_quiz_realtime.connect(websocket, game_id, player)
