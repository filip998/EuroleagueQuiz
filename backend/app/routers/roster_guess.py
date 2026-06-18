import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query, WebSocket
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.game_actions import (
    GameActionError,
    http_exception_for_game_action_error,
    raise_http_game_action_error,
    websocket_error_payload,
)
from app.schemas.roster_guess import (
    RosterGuessCreateRequest,
    RosterGuessGuessRequest,
    RosterGuessEndResponseRequest,
    RosterGuessJoinRequest,
    RosterGuessQuickMatchCancelRequest,
    RosterGuessQuickMatchPoolCounts,
    RosterGuessQuickMatchPoolsResponse,
    RosterGuessQuickMatchRequest,
    RosterGuessRaceCreateRequest,
    RosterGuessRaceJoinRequest,
)
from app.schemas.realtime import state_message
from app.services.roster_guess import (
    get_game_or_404,
    serialize_game_state,
    autocomplete_players,
)
from app.services.game_action_orchestration import (
    GameActionName,
    HttpGameActionRejected,
)
from app.services.matchmaking import (
    MatchmakingCancelRequest,
    MatchmakingRequest,
    MatchmakingStatus,
    cancel_search,
    find_or_create_match,
)
from app.services.matchmaking_adapters import (
    ROSTER_GUESS_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS,
    RosterGuessMatchmakingAdapter,
)
from app.services.realtime import OnlineGameRealtimeModule
from app.services.realtime_adapters import RosterGuessRealtimeAdapter

router = APIRouter()
logger = logging.getLogger(__name__)
roster_guess_matchmaking = RosterGuessMatchmakingAdapter()
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


def _game_action_error_response(exc: GameActionError) -> JSONResponse:
    http_exc = http_exception_for_game_action_error(exc)
    return JSONResponse(
        status_code=http_exc.status_code,
        content=websocket_error_payload(exc),
    )


async def _apply_quick_match_pair_effects(result, game_state: dict) -> None:
    if result.status != MatchmakingStatus.MATCHED:
        return
    try:
        roster_guess_realtime.start_timer_from_state(game_state)
    except Exception:
        logger.exception("Post-commit roster quick-match side effect failed: start timer")

    try:
        await roster_guess_realtime.broadcast_state(game_state["id"], game_state)
    except Exception:
        logger.exception("Post-commit roster quick-match side effect failed: broadcast state")


def _cancelled_quick_match_state(result) -> dict:
    game = result.game
    return {
        "id": game.id,
        "mode": "online_friend",
        "status": "cancelled",
        "join_code": None,
        "is_race": True,
        "is_public": True,
        "preset": result.preset,
        "target_wins": game.target_wins,
        "turn_seconds": None,
        "turn_deadline_utc": None,
        "race_round_seconds": game.race_round_seconds,
        "race_reveal_seconds": game.race_reveal_seconds,
        "race_round_deadline_utc": None,
        "player1_name": game.player1_name or "Player 1",
        "player2_name": game.player2_name or "Player 2",
        "player1_score": game.player1_score,
        "player2_score": game.player2_score,
        "current_player": 0,
        "round_number": game.round_number,
        "winner_player": game.winner_player,
        "season_range_start": game.season_range_start,
        "season_range_end": game.season_range_end,
        "pending_end": None,
        "round": None,
        "latest_completed_round": None,
    }


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


@router.post("/roster-guess/race/games")
async def create_roster_guess_race_game(
    payload: RosterGuessRaceCreateRequest,
    db: Session = Depends(get_db),
):
    race_payload = payload.model_dump()
    race_payload["is_race"] = True
    return await _roster_guess_http_action(
        db,
        GameActionName.CREATE,
        payload=race_payload,
    )


@router.post("/roster-guess/race/games/join")
async def join_roster_guess_race_game(
    payload: RosterGuessRaceJoinRequest,
    db: Session = Depends(get_db),
):
    race_payload = payload.model_dump()
    race_payload["is_race"] = True
    return await _roster_guess_http_action(
        db,
        GameActionName.JOIN,
        payload=race_payload,
    )


@router.post("/roster-guess/quick-match")
async def quick_match_roster_guess_race(
    payload: RosterGuessQuickMatchRequest,
    db: Session = Depends(get_db),
):
    try:
        result = await find_or_create_match(
            db,
            roster_guess_matchmaking,
            MatchmakingRequest(
                preset=payload.preset,
                player_name=payload.player_name,
                guest_id=payload.guest_id,
            ),
        )
        game_state = serialize_game_state(db, result.game)
        await _apply_quick_match_pair_effects(result, game_state)
        return state_message(game_state)
    except GameActionError as exc:
        return _game_action_error_response(exc)


@router.post("/roster-guess/quick-match/cancel")
async def cancel_quick_match_roster_guess_race(
    payload: RosterGuessQuickMatchCancelRequest,
    db: Session = Depends(get_db),
):
    try:
        result = await cancel_search(
            db,
            roster_guess_matchmaking,
            MatchmakingCancelRequest(
                preset=payload.preset,
                game_id=payload.game_id,
                guest_id=payload.guest_id,
            ),
        )
        return state_message(_cancelled_quick_match_state(result))
    except GameActionError as exc:
        return _game_action_error_response(exc)


@router.get(
    "/roster-guess/quick-match/pools",
    response_model=RosterGuessQuickMatchPoolsResponse,
)
def get_roster_guess_quick_match_pools(db: Session = Depends(get_db)):
    counts = roster_guess_matchmaking.pool_presence_counts(db)
    return RosterGuessQuickMatchPoolsResponse(
        pools={
            preset: RosterGuessQuickMatchPoolCounts(
                searching=count.searching,
                in_progress=count.in_progress,
            )
            for preset, count in counts.items()
        },
        poll_interval_seconds=ROSTER_GUESS_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS,
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
