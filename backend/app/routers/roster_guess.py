import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app.game_actions import (
    GameActionError,
    raise_http_game_action_error,
    run_game_action,
    run_http_game_action,
    websocket_error_payload,
)
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
from app.services.roster_timer_manager import start_turn_timer, cancel_timer

router = APIRouter()


# ---------------------------------------------------------------------------
# WebSocket connection manager (same pattern as TicTacToe)
# ---------------------------------------------------------------------------


class RGConnectionManager:
    def __init__(self):
        self.connections: dict[int, dict[int, WebSocket]] = {}

    async def connect(self, game_id: int, player: int, ws: WebSocket):
        await ws.accept()
        self.connections.setdefault(game_id, {})[player] = ws

    def disconnect(self, game_id: int, player: int):
        if game_id in self.connections:
            self.connections[game_id].pop(player, None)
            if not self.connections[game_id]:
                del self.connections[game_id]

    async def broadcast(self, game_id: int, state: dict):
        conns = self.connections.get(game_id, {})
        for ws in list(conns.values()):
            try:
                await ws.send_json(state)
            except Exception:
                pass


rg_ws_manager = RGConnectionManager()


def _try_broadcast(game_id: int, state: dict):
    """Best-effort broadcast game state to connected WebSocket clients."""
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(rg_ws_manager.broadcast(game_id, state))
    except RuntimeError:
        try:
            loop = asyncio.get_event_loop()
            asyncio.run_coroutine_threadsafe(rg_ws_manager.broadcast(game_id, state), loop)
        except Exception:
            pass


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
        result = submit_guess(db, game=game, player_id=payload.player_id)
        return game, result

    game, result = run_http_game_action(db, action)
    db.refresh(game)
    state = serialize_game_state(db, game)
    state["last_result"] = result

    if result == "match_won":
        cancel_timer(game_id)
    elif result in ("round_won", "round_complete"):
        start_turn_timer(game_id, game.turn_seconds, game.current_player, game.round_number)

    _try_broadcast(game_id, state)
    return {"result": result, "game": state}


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
    _try_broadcast(game_id, state)
    return {"result": "end_offered", "game": state}


@router.post("/roster-guess/games/{game_id}/end-response")
async def respond_end_round(
    game_id: int,
    payload: RosterGuessEndResponseRequest,
    db: Session = Depends(get_db),
):
    def action():
        game = get_game_or_404(db, game_id)
        result = respond_end(db, game, accept=payload.accept)
        return game, result

    game, result = run_http_game_action(db, action)
    db.refresh(game)
    state = serialize_game_state(db, game)

    if game.status == "finished":
        cancel_timer(game_id)
    elif game.status == "active":
        start_turn_timer(game_id, game.turn_seconds, game.current_player, game.round_number)

    _try_broadcast(game_id, state)
    return {"result": result, "game": state}


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
    await rg_ws_manager.broadcast(game.id, state)
    start_turn_timer(game.id, game.turn_seconds, game.current_player, game.round_number)
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
    db = SessionLocal()
    try:
        game = get_game_or_404(db, game_id)
        await rg_ws_manager.connect(game_id, player, websocket)
        state = serialize_game_state(db, game)
        await websocket.send_json(state)

        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            try:
                db.expire(game)
                db.refresh(game)

                if action == "guess":
                    player_id = data["player_id"]
                    result = run_game_action(
                        db,
                        lambda: submit_guess(
                            db, game=game, player_id=player_id, acting_player=player,
                        ),
                    )
                    db.refresh(game)
                    state = serialize_game_state(db, game)
                    state["last_result"] = result
                    if result == "match_won":
                        cancel_timer(game_id)
                    elif result in ("round_won", "round_complete"):
                        start_turn_timer(game_id, game.turn_seconds, game.current_player, game.round_number)
                    else:
                        start_turn_timer(game_id, game.turn_seconds, game.current_player, game.round_number)
                    await rg_ws_manager.broadcast(game_id, state)
                    continue
                elif action == "offer_end":
                    run_game_action(
                        db,
                        lambda: offer_end(db, game, acting_player=player),
                    )
                    db.refresh(game)
                elif action == "respond_end":
                    run_game_action(
                        db,
                        lambda: respond_end(
                            db, game, accept=data.get("accept", False),
                            acting_player=player,
                        ),
                    )
                    db.refresh(game)
                    if game.status == "finished":
                        cancel_timer(game_id)
                    elif game.status == "active":
                        start_turn_timer(game_id, game.turn_seconds, game.current_player, game.round_number)
                elif action == "time_expired":
                    continue
                else:
                    await websocket.send_json({"error": f"Unknown action: {action}"})
                    continue

                state = serialize_game_state(db, game)
                await rg_ws_manager.broadcast(game_id, state)

            except GameActionError as exc:
                await websocket.send_json(websocket_error_payload(exc))

    except WebSocketDisconnect:
        rg_ws_manager.disconnect(game_id, player)
    except Exception:
        rg_ws_manager.disconnect(game_id, player)
    finally:
        db.close()
