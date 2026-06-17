from fastapi import APIRouter, Depends, Query, WebSocket
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.game_actions import GameActionError, raise_http_game_action_error, run_http_game_action
from app.schemas.career_quiz import (
    CareerQuizCreateRequest,
    CareerQuizGuessRequest,
    CareerQuizJoinRequest,
    CareerQuizNoAnswerOfferRequest,
    CareerQuizNoAnswerResponseRequest,
    CareerSoloGuessRequest,
    CareerSoloHintRequest,
    CareerSoloRevealRequest,
    CareerSoloRoundRequest,
)
from app.services import career_quiz as career_service
from app.services.game_action_orchestration import (
    GameActionName,
    HttpGameActionRejected,
)
from app.services.realtime import OnlineGameRealtimeModule
from app.services.realtime_adapters import CareerQuizRealtimeAdapter

router = APIRouter()
career_quiz_realtime = OnlineGameRealtimeModule(CareerQuizRealtimeAdapter())


async def _career_quiz_http_action(
    db: Session,
    action: GameActionName,
    *,
    payload=None,
    game_id: int | None = None,
    player: int | None = None,
):
    try:
        return await career_quiz_realtime.game_actions.http_action(
            db=db,
            action=action,
            payload=payload,
            game_id=game_id,
            player=player,
        )
    except HttpGameActionRejected as exc:
        return JSONResponse(status_code=exc.status_code, content=exc.envelope)


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


@router.post("/career/solo/hint")
def get_solo_hint(payload: CareerSoloHintRequest, db: Session = Depends(get_db)):
    return run_http_game_action(
        db,
        lambda: career_service.get_solo_hint(
            db,
            round_token=payload.round_token,
            shown_hints=payload.shown_hints,
            revealed_letters=payload.revealed_letters,
        ),
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
async def create_game(payload: CareerQuizCreateRequest, db: Session = Depends(get_db)):
    return await _career_quiz_http_action(
        db,
        GameActionName.CREATE,
        payload=payload,
    )


@router.post("/career/games/join")
async def join_game(payload: CareerQuizJoinRequest, db: Session = Depends(get_db)):
    return await _career_quiz_http_action(
        db,
        GameActionName.JOIN,
        payload=payload,
    )


@router.get("/career/games/{game_id}")
def get_game(game_id: int, db: Session = Depends(get_db)):
    try:
        return career_service.serialize_game_state(
            db, career_service.get_game_or_404(db, game_id)
        )
    except GameActionError as exc:
        raise_http_game_action_error(exc)


@router.post("/career/games/{game_id}/guess")
async def submit_guess(
    game_id: int,
    payload: CareerQuizGuessRequest,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    return await _career_quiz_http_action(
        db,
        GameActionName.GUESS,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/career/games/{game_id}/no-answer-offer")
async def offer_no_answer(
    game_id: int,
    payload: CareerQuizNoAnswerOfferRequest,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    return await _career_quiz_http_action(
        db,
        GameActionName.OFFER_NO_ANSWER,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/career/games/{game_id}/no-answer-response")
async def respond_no_answer(
    game_id: int,
    payload: CareerQuizNoAnswerResponseRequest,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    return await _career_quiz_http_action(
        db,
        GameActionName.RESPOND_NO_ANSWER,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.websocket("/career/ws/{game_id}")
async def career_quiz_websocket(websocket: WebSocket, game_id: int, player: int = 1):
    await career_quiz_realtime.connect(websocket, game_id, player)
