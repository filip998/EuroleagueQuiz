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
from app.schemas.guess_the_list import (
    GuessTheListCreateRequest,
    GuessTheListGuessRequest,
    GuessTheListEndResponseRequest,
    GuessTheListJoinRequest,
    GuessTheListQuickMatchCancelRequest,
    GuessTheListQuickMatchPoolCounts,
    GuessTheListQuickMatchPoolsResponse,
    GuessTheListQuickMatchRequest,
    GuessTheListRaceCreateRequest,
    GuessTheListRaceJoinRequest,
)
from app.schemas.realtime import state_message
from app.services.guess_the_list import (
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
    GUESS_THE_LIST_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS,
    GuessTheListMatchmakingAdapter,
)
from app.services.realtime import OnlineGameRealtimeModule
from app.services.realtime_adapters import GuessTheListRealtimeAdapter

router = APIRouter()
logger = logging.getLogger(__name__)
guess_the_list_matchmaking = GuessTheListMatchmakingAdapter()
guess_the_list_realtime = OnlineGameRealtimeModule(GuessTheListRealtimeAdapter())


async def _guess_the_list_http_action(
    db: Session,
    action: GameActionName,
    *,
    payload=None,
    game_id: int | None = None,
    player: int | None = None,
):
    try:
        return await guess_the_list_realtime.game_actions.http_action(
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
        guess_the_list_realtime.start_timer_from_state(game_state)
    except Exception:
        logger.exception(
            "Post-commit Guess the List quick-match side effect failed: start timer"
        )

    try:
        await guess_the_list_realtime.broadcast_state(game_state["id"], game_state)
    except Exception:
        logger.exception(
            "Post-commit Guess the List quick-match side effect failed: broadcast state"
        )


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
        "category_type": game.category_type,
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


@router.post("/games")
async def create_guess_the_list_game(
    payload: GuessTheListCreateRequest,
    db: Session = Depends(get_db),
):
    return await _guess_the_list_http_action(
        db,
        GameActionName.CREATE,
        payload=payload,
    )


@router.post("/race/games")
async def create_guess_the_list_race_game(
    payload: GuessTheListRaceCreateRequest,
    db: Session = Depends(get_db),
):
    race_payload = payload.model_dump()
    race_payload["is_race"] = True
    return await _guess_the_list_http_action(
        db,
        GameActionName.CREATE,
        payload=race_payload,
    )


@router.post("/race/games/join")
async def join_guess_the_list_race_game(
    payload: GuessTheListRaceJoinRequest,
    db: Session = Depends(get_db),
):
    race_payload = payload.model_dump()
    race_payload["is_race"] = True
    return await _guess_the_list_http_action(
        db,
        GameActionName.JOIN,
        payload=race_payload,
    )


@router.post("/quick-match")
async def quick_match_guess_the_list_race(
    payload: GuessTheListQuickMatchRequest,
    db: Session = Depends(get_db),
):
    try:
        result = await find_or_create_match(
            db,
            guess_the_list_matchmaking,
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


@router.post("/quick-match/cancel")
async def cancel_quick_match_guess_the_list_race(
    payload: GuessTheListQuickMatchCancelRequest,
    db: Session = Depends(get_db),
):
    try:
        result = await cancel_search(
            db,
            guess_the_list_matchmaking,
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
    "/quick-match/pools",
    response_model=GuessTheListQuickMatchPoolsResponse,
)
def get_guess_the_list_quick_match_pools(db: Session = Depends(get_db)):
    counts = guess_the_list_matchmaking.pool_presence_counts(db)
    return GuessTheListQuickMatchPoolsResponse(
        pools={
            preset: GuessTheListQuickMatchPoolCounts(
                searching=count.searching,
                in_progress=count.in_progress,
            )
            for preset, count in counts.items()
        },
        poll_interval_seconds=GUESS_THE_LIST_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS,
    )


@router.get("/games/{game_id}")
def get_guess_the_list_game(game_id: int, db: Session = Depends(get_db)):
    try:
        game = get_game_or_404(db, game_id)
        return serialize_game_state(db, game)
    except GameActionError as exc:
        raise_http_game_action_error(exc)


@router.post("/games/{game_id}/guess")
async def submit_guess_the_list(
    game_id: int,
    payload: GuessTheListGuessRequest,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _guess_the_list_http_action(
        db,
        GameActionName.GUESS,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/games/{game_id}/end-offer")
async def offer_end_round(
    game_id: int,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _guess_the_list_http_action(
        db,
        GameActionName.OFFER_END,
        game_id=game_id,
        player=player,
    )


@router.post("/games/{game_id}/end-response")
async def respond_end_round(
    game_id: int,
    payload: GuessTheListEndResponseRequest,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _guess_the_list_http_action(
        db,
        GameActionName.RESPOND_END,
        payload=payload,
        game_id=game_id,
        player=player,
    )


@router.post("/games/{game_id}/give-up")
async def give_up_round(
    game_id: int,
    player: int | None = Query(None),
    db: Session = Depends(get_db),
):
    return await _guess_the_list_http_action(
        db,
        GameActionName.GIVE_UP,
        game_id=game_id,
        player=player,
    )


@router.post("/games/join")
async def join_guess_the_list_game(
    payload: GuessTheListJoinRequest,
    db: Session = Depends(get_db),
):
    return await _guess_the_list_http_action(
        db,
        GameActionName.JOIN,
        payload=payload,
    )


@router.get("/players/autocomplete")
def guess_the_list_autocomplete(
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


@router.websocket("/ws/{game_id}")
async def guess_the_list_websocket(websocket: WebSocket, game_id: int, player: int = 1):
    await guess_the_list_realtime.connect(websocket, game_id, player)
