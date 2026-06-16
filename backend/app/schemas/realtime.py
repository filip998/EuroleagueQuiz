from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class RealtimeMessageType(StrEnum):
    STATE = "state"
    ERROR = "error"
    ACTION_ACK = "action_ack"


class RealtimeClientAction(StrEnum):
    MOVE = "move"
    OFFER_DRAW = "offer_draw"
    RESPOND_DRAW = "respond_draw"
    GUESS = "guess"
    OFFER_END = "offer_end"
    RESPOND_END = "respond_end"
    OFFER_NO_ANSWER = "offer_no_answer"
    RESPOND_NO_ANSWER = "respond_no_answer"
    TIME_EXPIRED = "time_expired"


class RealtimeResult(StrEnum):
    CORRECT = "correct"
    INCORRECT = "incorrect"
    ROUND_WON = "round_won"
    ROUND_DRAWN = "round_drawn"
    ROUND_COMPLETE = "round_complete"
    MATCH_WON = "match_won"
    BOARD_COMPLETE = "board_complete"
    DRAW_OFFERED = "draw_offered"
    DRAW_ACCEPTED = "draw_accepted"
    DRAW_DECLINED = "draw_declined"
    END_OFFERED = "end_offered"
    END_ACCEPTED = "end_accepted"
    END_DECLINED = "end_declined"
    NO_ANSWER_OFFERED = "no_answer_offered"
    NO_ANSWER_ACCEPTED = "no_answer_accepted"
    NO_ANSWER_DECLINED = "no_answer_declined"
    TIME_EXPIRED = "time_expired"
    GAVE_UP = "gave_up"
    GIVEN_UP = "given_up"


TERMINAL_RESULTS = frozenset({RealtimeResult.MATCH_WON})


class RealtimeStatePayload(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    game: dict[str, Any]
    result: RealtimeResult | None = None
    completed_round: dict[str, Any] | None = None
    terminal: bool = False


class RealtimeErrorPayload(BaseModel):
    code: str
    message: str


class RealtimeActionAckPayload(BaseModel):
    action: RealtimeClientAction
    accepted: bool = True


class RealtimeStateMessage(BaseModel):
    type: Literal[RealtimeMessageType.STATE] = RealtimeMessageType.STATE
    payload: RealtimeStatePayload


class RealtimeErrorMessage(BaseModel):
    type: Literal[RealtimeMessageType.ERROR] = RealtimeMessageType.ERROR
    payload: RealtimeErrorPayload


class RealtimeActionAckMessage(BaseModel):
    type: Literal[RealtimeMessageType.ACTION_ACK] = RealtimeMessageType.ACTION_ACK
    payload: RealtimeActionAckPayload


RealtimeServerMessage = Annotated[
    RealtimeStateMessage | RealtimeErrorMessage | RealtimeActionAckMessage,
    Field(discriminator="type"),
]
RealtimeServerMessageAdapter = TypeAdapter(RealtimeServerMessage)


def is_terminal_result(result: RealtimeResult | str | None, game_state: dict[str, Any]) -> bool:
    if result is not None and RealtimeResult(result) in TERMINAL_RESULTS:
        return True
    return game_state.get("status") == "finished"


def state_message(
    game_state: dict[str, Any],
    *,
    result: RealtimeResult | str | None = None,
    completed_round: dict[str, Any] | None = None,
) -> dict[str, Any]:
    parsed_result = RealtimeResult(result) if result is not None else None
    message = RealtimeStateMessage(
        payload=RealtimeStatePayload(
            game=game_state,
            result=parsed_result,
            completed_round=completed_round,
            terminal=is_terminal_result(parsed_result, game_state),
        )
    )
    return message.model_dump(mode="json", exclude_none=True)


def error_message(message: str, *, code: str = "invalid_action") -> dict[str, Any]:
    return RealtimeErrorMessage(
        payload=RealtimeErrorPayload(code=code, message=message)
    ).model_dump(mode="json")


def unknown_action_message(action: object) -> dict[str, Any]:
    return error_message(f"Unknown action: {action}", code="unknown_action")
