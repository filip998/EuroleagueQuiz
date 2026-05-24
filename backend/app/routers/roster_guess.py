from typing import Optional

from fastapi import APIRouter, Depends, Query, WebSocket
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.game_actions import (
    GameActionError,
    raise_http_game_action_error,
)
from app.schemas.roster_guess import (
    RosterGuessCreateRequest,
    RosterGuessGuessRequest,
    RosterGuessEndResponseRequest,
    RosterGuessJoinRequest,
)
from app.services.roster_guess import (
    get_game_or_404,
    serialize_game_state,
    autocomplete_players,
)
from app.services.game_action_orchestration import (
    GameActionName,
    HttpGameActionRejected,
)
from app.services.realtime import OnlineGameRealtimeModule
from app.services.realtime_adapters import RosterGuessRealtimeAdapter

router = APIRouter()
roster_guess_realtime = OnlineGameRealtimeModule(RosterGuessRealtimeAdapter())


async def _roster_guess_http_action(
    db: Session,
    action: GameActionName,
    *,
    payload=None,
    game_id: int | None = None,
    player: int | None = None,
):
    try:
        return await roster_guess_realtime.game_actions.http_action(
            db=db,
            action=action,
            payload=payload,
            game_id=game_id,
            player=player,
        )
    except HttpGameActionRejected as exc:
        return JSONResponse(status_code=exc.status_code, content=exc.envelope)


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------


@router.post("/roster-guess/games")
async def create_roster_guess_game(
    payload: RosterGuessCreateRequest,
    db: Session = Depends(get_db),
):
    return await _roster_guess_http_action(
        db,
        GameActionName.CREATE,
        payload=payload,
    )


@router.get("/roster-guess/games/{game_id}")
def get_roster_guess_game(game_id: int, db: Session = Depends(get_db)):
    try:
        game = get_game_or_404(db, game_id)
        return serialize_game_state(db, game)
    except GameActionError as exc:
        raise_http_game_action_error(exc)


@router.post("/roster-guess/games/{game_id}/guess")
async def submit_roster_guess(
    game_id: int,
    payload: RosterGuessGuessRequest,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _roster_guess_http_action(
        db,
        GameActionName.GUESS,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/roster-guess/games/{game_id}/end-offer")
async def offer_end_round(
    game_id: int,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _roster_guess_http_action(
        db,
        GameActionName.OFFER_END,
        game_id=game_id,
        player=player,
    )


@router.post("/roster-guess/games/{game_id}/end-response")
async def respond_end_round(
    game_id: int,
    payload: RosterGuessEndResponseRequest,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _roster_guess_http_action(
        db,
        GameActionName.RESPOND_END,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/roster-guess/games/{game_id}/give-up")
async def give_up_round(
    game_id: int,
    db: Session = Depends(get_db),
):
    return await _roster_guess_http_action(
        db,
        GameActionName.GIVE_UP,
        game_id=game_id,
    )


@router.post("/roster-guess/games/join")
async def join_roster_guess_game(
    payload: RosterGuessJoinRequest,
    db: Session = Depends(get_db),
):
    return await _roster_guess_http_action(
        db,
        GameActionName.JOIN,
        payload=payload,
    )


@router.get("/roster-guess/players/autocomplete")
def roster_guess_autocomplete(
    q: str = Query("", min_length=1, description="Search query"),
    limit: int = Query(15, ge=1, le=50),
    db: Session = Depends(get_db),
):
    try:
        players = autocomplete_players(db, q=q, limit=limit)
        return {"query": q, "count": len(players), "players": players}
    except GameActionError as exc:
        raise_http_game_action_error(exc)


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@router.websocket("/roster-guess/ws/{game_id}")
async def roster_guess_websocket(websocket: WebSocket, game_id: int, player: int = 1):
    await roster_guess_realtime.connect(websocket, game_id, player)
