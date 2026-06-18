import logging

from fastapi import APIRouter, Depends, Query, WebSocket
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.game_actions import (
    GameActionError,
    http_exception_for_game_action_error,
    raise_http_game_action_error,
    run_http_game_action,
    websocket_error_payload,
)
from app.schemas.career_quiz import (
    CareerQuizCreateRequest,
    CareerQuizGuessRequest,
    CareerQuizJoinRequest,
    CareerQuizNoAnswerOfferRequest,
    CareerQuizNoAnswerResponseRequest,
    CareerQuizQuickMatchCancelRequest,
    CareerQuizQuickMatchPoolCounts,
    CareerQuizQuickMatchPoolsResponse,
    CareerQuizQuickMatchRequest,
    CareerSoloGuessRequest,
    CareerSoloHintRequest,
    CareerSoloRevealRequest,
    CareerSoloRoundRequest,
)
from app.schemas.realtime import state_message
from app.services import career_quiz as career_service
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
    CAREER_QUIZ_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS,
    CareerQuizMatchmakingAdapter,
)
from app.services.realtime import OnlineGameRealtimeModule
from app.services.realtime_adapters import CareerQuizRealtimeAdapter

router = APIRouter()
logger = logging.getLogger(__name__)
career_quiz_matchmaking = CareerQuizMatchmakingAdapter()
career_quiz_realtime = OnlineGameRealtimeModule(
    CareerQuizRealtimeAdapter(career_quiz_matchmaking)
)


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


def _game_action_error_response(exc: GameActionError) -> JSONResponse:
    http_exc = http_exception_for_game_action_error(exc)
    return JSONResponse(
        status_code=http_exc.status_code,
        content=websocket_error_payload(exc),
    )


async def _apply_quick_match_pair_effects(
    result,
    game_state: dict,
) -> None:
    if result.status != MatchmakingStatus.MATCHED or result.starting_player is None:
        return
    try:
        career_quiz_realtime.start_timer_from_state(game_state)
    except Exception:
        logger.exception("Post-commit career quick-match side effect failed: start timer")

    try:
        await career_quiz_realtime.broadcast_state(game_state["id"], game_state)
    except Exception:
        logger.exception("Post-commit career quick-match side effect failed: broadcast state")


def _cancelled_quick_match_state(result) -> dict:
    game = result.game
    return {
        "id": game.id,
        "mode": "online_friend",
        "status": "cancelled",
        "join_code": None,
        "is_public": True,
        "preset": result.preset,
        "target_wins": game.target_wins,
        "wrong_guess_visibility": game.wrong_guess_visibility,
        "player1_name": game.player1_name,
        "player2_name": game.player2_name,
        "player1_score": game.player1_score,
        "player2_score": game.player2_score,
        "round_number": game.round_number,
        "winner_player": game.winner_player,
        "pending_no_answer_from": None,
        "pending_no_answer_to": None,
        "current_round": None,
        "latest_completed_round": None,
    }


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


@router.post("/career/quick-match")
async def quick_match_career_game(
    payload: CareerQuizQuickMatchRequest,
    db: Session = Depends(get_db),
):
    try:
        result = await find_or_create_match(
            db,
            career_quiz_matchmaking,
            MatchmakingRequest(
                preset=payload.preset,
                player_name=payload.player_name,
                guest_id=payload.guest_id,
            ),
        )
        game_state = career_service.serialize_game_state(db, result.game)
        await _apply_quick_match_pair_effects(result, game_state)
        return state_message(game_state)
    except GameActionError as exc:
        return _game_action_error_response(exc)


@router.post("/career/quick-match/cancel")
async def cancel_quick_match_career_game(
    payload: CareerQuizQuickMatchCancelRequest,
    db: Session = Depends(get_db),
):
    try:
        result = await cancel_search(
            db,
            career_quiz_matchmaking,
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
    "/career/quick-match/pools",
    response_model=CareerQuizQuickMatchPoolsResponse,
)
def get_career_quick_match_pools(db: Session = Depends(get_db)):
    counts = career_quiz_matchmaking.pool_presence_counts(db)
    return CareerQuizQuickMatchPoolsResponse(
        pools={
            preset: CareerQuizQuickMatchPoolCounts(
                searching=count.searching,
                in_progress=count.in_progress,
            )
            for preset, count in counts.items()
        },
        poll_interval_seconds=CAREER_QUIZ_QUICK_MATCH_POOL_POLL_INTERVAL_SECONDS,
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


@router.post("/career/games/{game_id}/give-up")
async def resign_game(
    game_id: int,
    player: int = Query(..., ge=1, le=2),
    db: Session = Depends(get_db),
):
    return await _career_quiz_http_action(
        db,
        GameActionName.GIVE_UP,
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
