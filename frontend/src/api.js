import { parseRealtimeMessage } from "./realtimeSchema";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const WS_BASE = API_BASE.replace(/^http/, "ws");

async function request(method, path, body = null) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.payload?.message || err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function actionRequest(method, path, body = null) {
  return parseRealtimeMessage(await request(method, path, body));
}

export function createGame(payload) {
  return actionRequest("POST", "/quiz/tictactoe/games", payload);
}

export function getGame(gameId) {
  return request("GET", `/quiz/tictactoe/games/${gameId}`);
}

export function joinGame(joinCode, playerName) {
  return actionRequest("POST", "/quiz/tictactoe/games/join", {
    join_code: joinCode,
    player_name: playerName,
  });
}

export function submitMove(gameId, move) {
  return actionRequest("POST", `/quiz/tictactoe/games/${gameId}/moves`, move);
}

export function offerDraw(gameId) {
  return actionRequest("POST", `/quiz/tictactoe/games/${gameId}/draw-offer`);
}

export function respondDraw(gameId, accept) {
  return actionRequest("POST", `/quiz/tictactoe/games/${gameId}/draw-response`, {
    accept,
  });
}

export function giveUpGame(gameId) {
  return actionRequest("POST", `/quiz/tictactoe/games/${gameId}/give-up`);
}

export function autocompletePlayer(q, teamCode1, teamCode2, limit = 15) {
  const params = new URLSearchParams({ q, limit });
  if (teamCode1) params.set("team_code_1", teamCode1);
  if (teamCode2) params.set("team_code_2", teamCode2);
  return request("GET", `/quiz/tictactoe/players/autocomplete?${params}`);
}

function connectRealtimeWebSocket(path, { onMessage, onClose, WebSocketImpl = WebSocket }) {
  const ws = new WebSocketImpl(`${WS_BASE}${path}`);
  ws.onmessage = (event) => onMessage(parseRealtimeMessage(event.data));
  ws.onclose = () => onClose?.();
  return {
    send: (message) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
    isOpen: () => ws.readyState === (WebSocketImpl.OPEN ?? 1),
  };
}

export function connectTicTacToeRealtime({ gameId, playerNumber, onMessage, onClose, WebSocketImpl }) {
  return connectRealtimeWebSocket(
    `/quiz/tictactoe/ws/${gameId}?player=${playerNumber}`,
    { onMessage, onClose, WebSocketImpl }
  );
}

// ---------------------------------------------------------------------------
// Roster Guess API
// ---------------------------------------------------------------------------

export function createRosterGame(payload) {
  return actionRequest("POST", "/quiz/roster-guess/games", payload);
}

export function getRosterGame(gameId) {
  return request("GET", `/quiz/roster-guess/games/${gameId}`);
}

export function joinRosterGame(joinCode, playerName) {
  return actionRequest("POST", "/quiz/roster-guess/games/join", {
    join_code: joinCode,
    player_name: playerName,
  });
}

export function submitRosterGuess(gameId, playerId) {
  return actionRequest("POST", `/quiz/roster-guess/games/${gameId}/guess`, {
    player_id: playerId,
  });
}

export function offerEndRound(gameId) {
  return actionRequest("POST", `/quiz/roster-guess/games/${gameId}/end-offer`);
}

export function respondEndRound(gameId, accept) {
  return actionRequest("POST", `/quiz/roster-guess/games/${gameId}/end-response`, {
    accept,
  });
}

export function giveUpRosterRound(gameId) {
  return actionRequest("POST", `/quiz/roster-guess/games/${gameId}/give-up`);
}

export function autocompleteRosterPlayer(q, limit = 15) {
  const params = new URLSearchParams({ q, limit });
  return request("GET", `/quiz/roster-guess/players/autocomplete?${params}`);
}

export function connectRosterGuessRealtime({ gameId, playerNumber, onMessage, onClose, WebSocketImpl }) {
  return connectRealtimeWebSocket(
    `/quiz/roster-guess/ws/${gameId}?player=${playerNumber}`,
    { onMessage, onClose, WebSocketImpl }
  );
}

// ---------------------------------------------------------------------------
// Higher or Lower API
// ---------------------------------------------------------------------------

export function createHigherLowerGame(payload) {
  return request("POST", "/quiz/higher-lower/games", payload);
}

export function submitHigherLowerAnswer(gameId, choice) {
  return request("POST", `/quiz/higher-lower/games/${gameId}/answer`, { choice });
}

export function getHigherLowerLeaderboard(tier) {
  return request("GET", `/quiz/higher-lower/leaderboard/${tier}`);
}
