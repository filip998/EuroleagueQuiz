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
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export function createGame(payload) {
  return request("POST", "/quiz/tictactoe/games", payload);
}

export function getGame(gameId) {
  return request("GET", `/quiz/tictactoe/games/${gameId}`);
}

export function joinGame(joinCode, playerName) {
  return request("POST", "/quiz/tictactoe/games/join", {
    join_code: joinCode,
    player_name: playerName,
  });
}

export function submitMove(gameId, move) {
  return request("POST", `/quiz/tictactoe/games/${gameId}/moves`, move);
}

export function offerDraw(gameId) {
  return request("POST", `/quiz/tictactoe/games/${gameId}/draw-offer`);
}

export function respondDraw(gameId, accept) {
  return request("POST", `/quiz/tictactoe/games/${gameId}/draw-response`, {
    accept,
  });
}

export function autocompletePlayer(q, teamCode1, teamCode2, limit = 15) {
  const params = new URLSearchParams({ q, limit });
  if (teamCode1) params.set("team_code_1", teamCode1);
  if (teamCode2) params.set("team_code_2", teamCode2);
  return request("GET", `/quiz/tictactoe/players/autocomplete?${params}`);
}

export function connectWebSocket(gameId, playerNumber, onMessage, onClose) {
  const ws = new WebSocket(
    `${WS_BASE}/quiz/tictactoe/ws/${gameId}?player=${playerNumber}`
  );
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    onMessage(data);
  };
  ws.onclose = () => {
    if (onClose) onClose();
  };
  return ws;
}

// ---------------------------------------------------------------------------
// Roster Guess API
// ---------------------------------------------------------------------------

export function createRosterGame(payload) {
  return request("POST", "/quiz/roster-guess/games", payload);
}

export function getRosterGame(gameId) {
  return request("GET", `/quiz/roster-guess/games/${gameId}`);
}

export function joinRosterGame(joinCode, playerName) {
  return request("POST", "/quiz/roster-guess/games/join", {
    join_code: joinCode,
    player_name: playerName,
  });
}

export function submitRosterGuess(gameId, playerId) {
  return request("POST", `/quiz/roster-guess/games/${gameId}/guess`, {
    player_id: playerId,
  });
}

export function offerEndRound(gameId) {
  return request("POST", `/quiz/roster-guess/games/${gameId}/end-offer`);
}

export function respondEndRound(gameId, accept) {
  return request("POST", `/quiz/roster-guess/games/${gameId}/end-response`, {
    accept,
  });
}

export function autocompleteRosterPlayer(q, limit = 15) {
  const params = new URLSearchParams({ q, limit });
  return request("GET", `/quiz/roster-guess/players/autocomplete?${params}`);
}

export function connectRosterWebSocket(gameId, playerNumber, onMessage, onClose) {
  const ws = new WebSocket(
    `${WS_BASE}/quiz/roster-guess/ws/${gameId}?player=${playerNumber}`
  );
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    onMessage(data);
  };
  ws.onclose = () => {
    if (onClose) onClose();
  };
  return ws;
}
