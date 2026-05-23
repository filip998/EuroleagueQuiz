export const REALTIME_MESSAGE_TYPES = {
  STATE: "state",
  ERROR: "error",
  ACTION_ACK: "action_ack",
};

export const REALTIME_CLIENT_ACTIONS = {
  MOVE: "move",
  OFFER_DRAW: "offer_draw",
  RESPOND_DRAW: "respond_draw",
  GUESS: "guess",
  OFFER_END: "offer_end",
  RESPOND_END: "respond_end",
  TIME_EXPIRED: "time_expired",
};

export const REALTIME_RESULTS = {
  CORRECT: "correct",
  INCORRECT: "incorrect",
  ROUND_WON: "round_won",
  ROUND_DRAWN: "round_drawn",
  ROUND_COMPLETE: "round_complete",
  MATCH_WON: "match_won",
  BOARD_COMPLETE: "board_complete",
  DRAW_OFFERED: "draw_offered",
  DRAW_ACCEPTED: "draw_accepted",
  DRAW_DECLINED: "draw_declined",
  END_OFFERED: "end_offered",
  END_ACCEPTED: "end_accepted",
  END_DECLINED: "end_declined",
  TIME_EXPIRED: "time_expired",
  GAVE_UP: "gave_up",
  GIVEN_UP: "given_up",
};

export function parseRealtimeMessage(raw) {
  const message = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!message || typeof message !== "object") {
    throw new Error("Invalid realtime message");
  }

  if (message.type === REALTIME_MESSAGE_TYPES.STATE) {
    const payload = message.payload || {};
    return {
      kind: REALTIME_MESSAGE_TYPES.STATE,
      state: payload.game,
      result: payload.result || null,
      completedRound: payload.completed_round || null,
      terminal: Boolean(payload.terminal),
    };
  }

  if (message.type === REALTIME_MESSAGE_TYPES.ERROR) {
    const payload = message.payload || {};
    return {
      kind: REALTIME_MESSAGE_TYPES.ERROR,
      error: payload.message || "Realtime error",
      code: payload.code || "unknown",
    };
  }

  if (message.type === REALTIME_MESSAGE_TYPES.ACTION_ACK) {
    return {
      kind: REALTIME_MESSAGE_TYPES.ACTION_ACK,
      action: message.payload?.action,
      accepted: message.payload?.accepted !== false,
    };
  }

  throw new Error(`Unknown realtime message type: ${message.type}`);
}
