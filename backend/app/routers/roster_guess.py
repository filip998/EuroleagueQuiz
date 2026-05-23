from typing import Optional

from fastapi import APIRouter, Depends, Query, WebSocket
from sqlalchemy.orm import Session

from app.database import get_db
from app.game_actions import (
    GameActionError,
    raise_http_game_action_error,
    run_http_game_action,
)
from app.schemas.realtime import RealtimeResult
from app.schemas.roster_guess import (
    RosterGuessCreateRequest,
    RosterGuessGuessRequest,
    RosterGuessEndResponseRequest,
    RosterGuessJoinRequest,
)
from app.services.roster_guess import (
    create_game,
    get_game_or_404,
    join_game,
    submit_guess,
    offer_end,
    respond_end,
    serialize_game_state,
    serialize_completed_round,
    autocomplete_players,
    give_up,
)
from app.services.realtime import OnlineGameRealtimeModule
from app.services.realtime_adapters import RosterGuessRealtimeAdapter

router = APIRouter()
roster_guess_realtime = OnlineGameRealtimeModule(RosterGuessRealtimeAdapter())


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------


@router.post("/roster-guess/games")
async def create_roster_guess_game(
    payload: RosterGuessCreateRequest,
    db: Session = Depends(get_db),
):
    game = run_http_game_action(
        db,
        lambda: create_game(
            db,
            mode=payload.mode,
            target_wins=payload.target_wins,
            timer_mode=payload.timer_mode,
            player1_name=payload.player1_name,
            player2_name=payload.player2_name,
            season_range_start=payload.season_range_start,
            season_range_end=payload.season_range_end,
        ),
    )
    db.refresh(game)
    state = serialize_game_state(db, game)
    if payload.mode == "online_friend":
        return {"game_id": game.id, "game": state}
    return {"game": state}


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
    db: Session = Depends(get_db),
):
    def action():
        game = get_game_or_404(db, game_id)
        prev_round_number = game.round_number
        result = submit_guess(db, game=game, player_id=payload.player_id)
        return game, prev_round_number, result

    game, prev_round_number, result = run_http_game_action(db, action)
    db.refresh(game)
    state = serialize_game_state(db, game)
    completed = None
    if result in ("round_won", "round_complete", "match_won", "board_complete"):
        completed = serialize_completed_round(db, game.id, prev_round_number)

    if game.mode == "online_friend":
        if result == RealtimeResult.MATCH_WON:
            roster_guess_realtime.cancel_timer(game_id)
        else:
            roster_guess_realtime.start_timer_from_game(game)

    await roster_guess_realtime.broadcast_state(
        game_id,
        state,
        result=result,
        completed_round=completed,
    )
    response = {"result": result, "game": state}
    if completed:
        response["completed_round"] = completed
    return response


@router.post("/roster-guess/games/{game_id}/end-offer")
async def offer_end_round(
    game_id: int,
    db: Session = Depends(get_db),
):
    def action():
        game = get_game_or_404(db, game_id)
        offer_end(db, game)
        return game

    game = run_http_game_action(db, action)
    db.refresh(game)
    state = serialize_game_state(db, game)
    await roster_guess_realtime.broadcast_state(game_id, state)
    return {"result": "end_offered", "game": state}


@router.post("/roster-guess/games/{game_id}/end-response")
async def respond_end_round(
    game_id: int,
    payload: RosterGuessEndResponseRequest,
    db: Session = Depends(get_db),
):
    def action():
        game = get_game_or_404(db, game_id)
        prev_round_number = game.round_number
        result = respond_end(db, game, accept=payload.accept)
        return game, prev_round_number, result

    game, prev_round_number, result = run_http_game_action(db, action)
    db.refresh(game)
    state = serialize_game_state(db, game)
    completed = None
    if result in ("round_won", "round_complete", "match_won", "board_complete"):
        completed = serialize_completed_round(db, game.id, prev_round_number)

    if game.mode == "online_friend":
        if game.status == "finished":
            roster_guess_realtime.cancel_timer(game_id)
        elif game.status == "active":
            roster_guess_realtime.start_timer_from_game(game)

    await roster_guess_realtime.broadcast_state(
        game_id,
        state,
        result=("end_declined" if result == "declined" else result),
        completed_round=completed,
    )
    response = {"result": result, "game": state}
    if completed:
        response["completed_round"] = completed
    return response


@router.post("/roster-guess/games/{game_id}/give-up")
async def give_up_round(
    game_id: int,
    db: Session = Depends(get_db),
):
    def action():
        game = get_game_or_404(db, game_id)
        given_up_round_number = give_up(db, game)
        return game, given_up_round_number

    game, given_up_round_number = run_http_game_action(db, action)
    db.refresh(game)
    state = serialize_game_state(db, game)
    completed = serialize_completed_round(db, game.id, given_up_round_number)
    response = {"result": "given_up", "game": state}
    if completed:
        response["completed_round"] = completed
    return response


@router.post("/roster-guess/games/join")
async def join_roster_guess_game(
    payload: RosterGuessJoinRequest,
    db: Session = Depends(get_db),
):
    game = run_http_game_action(
        db,
        lambda: join_game(db, payload.join_code.upper(), payload.player_name),
    )
    db.refresh(game)
    state = serialize_game_state(db, game)
    await roster_guess_realtime.broadcast_state(game.id, state)
    roster_guess_realtime.start_timer_from_game(game)
    return {"game_id": game.id, "game": state}


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
