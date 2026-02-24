const API_BASE = "http://localhost:8000";

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
