import { parseRealtimeMessage } from "./realtimeSchema";
import { getGuestId } from "./identity";
import { getAuthToken } from "./authToken";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const WS_BASE = API_BASE.replace(/^http/, "ws");
let tictactoeTimingCounter = 0;

async function request(method, path, body = null, { authToken, clientTiming } = {}) {
  const headers = { "Content-Type": "application/json" };
  // Additive auth: attach the Clerk session token only when signed in. Signed-out
  // (anonymous) play registers no provider, so no Authorization header is sent.
  // Callers may pass an already-fetched token (`authToken`) to send exactly that
  // token — used by link-guest so its pre-flight token is the one transmitted
  // rather than a second, racy registry lookup.
  const token = authToken !== undefined ? authToken : await getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  clientTiming?.markFetchStart();
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, opts);
  } finally {
    clientTiming?.markFetchEnd();
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const error = new Error(err.payload?.message || err.detail || `HTTP ${res.status}`);
    error.status = res.status;
    error.detail = err.detail;
    error.payload = err.payload;
    throw error;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function actionRequest(method, path, body = null, options = {}) {
  return parseRealtimeMessage(await request(method, path, body, options));
}

async function withTicTacToeClientTiming(action, run) {
  const timing = createTicTacToeClientTiming(action);
  try {
    return await run(timing);
  } finally {
    timing?.markPaint();
  }
}

function createTicTacToeClientTiming(action) {
  if (
    !import.meta.env.DEV ||
    typeof performance === "undefined" ||
    typeof performance.mark !== "function" ||
    typeof performance.measure !== "function"
  ) {
    return null;
  }

  tictactoeTimingCounter += 1;
  const prefix = `elq.tictactoe.${action}.${Date.now()}.${tictactoeTimingCounter}`;
  mark(`${prefix}.input`);
  return {
    markFetchStart() {
      mark(`${prefix}.fetch_start`);
      measure(`${prefix}.input_to_fetch_start`, `${prefix}.input`, `${prefix}.fetch_start`);
    },
    markFetchEnd() {
      mark(`${prefix}.fetch_end`);
      measure(`${prefix}.fetch`, `${prefix}.fetch_start`, `${prefix}.fetch_end`);
      measure(`${prefix}.input_to_fetch_end`, `${prefix}.input`, `${prefix}.fetch_end`);
    },
    markPaint() {
      const markPaintDone = () => {
        mark(`${prefix}.paint`);
        measure(`${prefix}.fetch_end_to_paint`, `${prefix}.fetch_end`, `${prefix}.paint`);
        measure(`${prefix}.input_to_paint`, `${prefix}.input`, `${prefix}.paint`);
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(markPaintDone);
      } else {
        setTimeout(markPaintDone, 0);
      }
    },
  };
}

function mark(name) {
  try {
    performance.mark(name);
  } catch {
    // Dev-only instrumentation must never affect gameplay.
  }
}

function measure(name, startMark, endMark) {
  try {
    performance.measure(name, startMark, endMark);
  } catch {
    // Dev-only instrumentation must never affect gameplay.
  }
}

// ---------------------------------------------------------------------------
// Auth (additive — only meaningful when signed in via Clerk)
// ---------------------------------------------------------------------------

// Resolves the local user for the current Clerk Bearer token, JIT-provisioning
// on first call. Requires a valid token (caller must be signed in).
export function getAuthMe() {
  return request("GET", "/auth/me");
}

// Best-effort: associate the current guest id with the signed-in user after
// sign-in. Idempotent server-side; callers must swallow failures so a missing
// or briefly-unavailable endpoint never blocks sign-in. Pass the caller's
// already-fetched Bearer token so the request carries exactly that token;
// when no token is available (signed out / no key) this no-ops without sending
// a request, so link-guest is never POSTed unauthenticated.
export async function linkGuest(authToken) {
  const token = authToken !== undefined ? authToken : await getAuthToken();
  if (!token) return null;
  return request("POST", "/auth/link-guest", { guest_id: getGuestId() }, { authToken: token });
}

export function createGame(payload) {
  return withTicTacToeClientTiming("create", (clientTiming) =>
    actionRequest(
      "POST",
      "/quiz/tictactoe/games",
      { ...payload, guest_id: getGuestId() },
      { clientTiming }
    )
  );
}

export function getGame(gameId) {
  return request("GET", `/quiz/tictactoe/games/${gameId}`);
}

export function joinGame(joinCode, playerName) {
  return actionRequest("POST", "/quiz/tictactoe/games/join", {
    join_code: joinCode,
    player_name: playerName,
    guest_id: getGuestId(),
  });
}

export function submitMove(gameId, move) {
  return withTicTacToeClientTiming("move", (clientTiming) =>
    actionRequest("POST", `/quiz/tictactoe/games/${gameId}/moves`, move, {
      clientTiming,
    })
  );
}

export function offerDraw(gameId) {
  return actionRequest("POST", `/quiz/tictactoe/games/${gameId}/draw-offer`);
}

export function respondDraw(gameId, accept) {
  return actionRequest("POST", `/quiz/tictactoe/games/${gameId}/draw-response`, {
    accept,
  });
}

export function giveUpGame(gameId, player = null) {
  const query = player != null ? `?player=${player}` : "";
  return actionRequest("POST", `/quiz/tictactoe/games/${gameId}/give-up${query}`);
}

export function quickMatchTicTacToe(payload) {
  return actionRequest("POST", "/quiz/tictactoe/quick-match", {
    ...payload,
    guest_id: getGuestId(),
  });
}

export function cancelQuickMatchTicTacToe(payload) {
  return actionRequest("POST", "/quiz/tictactoe/quick-match/cancel", {
    ...payload,
    guest_id: getGuestId(),
  });
}

export function fetchTicTacToeQuickMatchPools() {
  return request("GET", "/quiz/tictactoe/quick-match/pools");
}

export function autocompletePlayer(q, teamCode1, teamCode2, limit = 15) {
  const params = new URLSearchParams({ q, limit });
  if (teamCode1) params.set("team_code_1", teamCode1);
  if (teamCode2) params.set("team_code_2", teamCode2);
  return request("GET", `/quiz/tictactoe/players/autocomplete?${params}`);
}

function connectRealtimeWebSocket(path, { onMessage, onClose, WebSocketImpl = WebSocket, authToken }) {
  const tokenQuery = authToken
    ? `${path.includes("?") ? "&" : "?"}${new URLSearchParams({ token: authToken })}`
    : "";
  const ws = new WebSocketImpl(`${WS_BASE}${path}${tokenQuery}`);
  ws.onmessage = (event) => onMessage(parseRealtimeMessage(event.data));
  ws.onclose = () => onClose?.();
  return {
    send: (message) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
    isOpen: () => ws.readyState === (WebSocketImpl.OPEN ?? 1),
  };
}

export function connectTicTacToeRealtime({
  gameId,
  playerNumber,
  onMessage,
  onClose,
  WebSocketImpl,
  authToken,
}) {
  return connectRealtimeWebSocket(
    `/quiz/tictactoe/ws/${gameId}?player=${playerNumber}`,
    { onMessage, onClose, WebSocketImpl, authToken }
  );
}

// ---------------------------------------------------------------------------
// Guess the List API
// ---------------------------------------------------------------------------

export function createGuessTheListGame(payload) {
  return actionRequest("POST", "/quiz/guess-the-list/games", { ...payload, guest_id: getGuestId() });
}

export function getGuessTheListGame(gameId) {
  return request("GET", `/quiz/guess-the-list/games/${gameId}`);
}

export function joinGuessTheListGame(joinCode, playerName) {
  return actionRequest("POST", "/quiz/guess-the-list/games/join", {
    join_code: joinCode,
    player_name: playerName,
    guest_id: getGuestId(),
  });
}

export function createGuessTheListRaceGame(payload) {
  return actionRequest("POST", "/quiz/guess-the-list/race/games", {
    ...payload,
    guest_id: getGuestId(),
  });
}

export function joinGuessTheListRaceGame(joinCode, playerName) {
  return actionRequest("POST", "/quiz/guess-the-list/race/games/join", {
    join_code: joinCode,
    player_name: playerName,
    guest_id: getGuestId(),
  });
}

export function quickMatchGuessTheListRace(payload) {
  return actionRequest("POST", "/quiz/guess-the-list/quick-match", {
    ...payload,
    guest_id: getGuestId(),
  });
}

export function cancelGuessTheListRaceQuickMatch(payload) {
  return actionRequest("POST", "/quiz/guess-the-list/quick-match/cancel", {
    ...payload,
    guest_id: getGuestId(),
  });
}

export function getGuessTheListRaceQuickMatchPools() {
  return request("GET", "/quiz/guess-the-list/quick-match/pools");
}

export function submitGuessTheList(gameId, playerId, roundNumber = null) {
  const body = { player_id: playerId };
  if (roundNumber != null) body.round_number = roundNumber;
  return actionRequest("POST", `/quiz/guess-the-list/games/${gameId}/guess`, body);
}

export function offerEndRound(gameId) {
  return actionRequest("POST", `/quiz/guess-the-list/games/${gameId}/end-offer`);
}

export function respondEndRound(gameId, accept) {
  return actionRequest("POST", `/quiz/guess-the-list/games/${gameId}/end-response`, {
    accept,
  });
}

export function giveUpGuessTheListRound(gameId) {
  return actionRequest("POST", `/quiz/guess-the-list/games/${gameId}/give-up`);
}

export function resignGuessTheListRaceGame(gameId, player) {
  return actionRequest("POST", `/quiz/guess-the-list/games/${gameId}/give-up?player=${player}`);
}

export function autocompleteGuessTheListPlayer(q, limit = 15) {
  const params = new URLSearchParams({ q, limit });
  return request("GET", `/quiz/guess-the-list/players/autocomplete?${params}`);
}

export function connectGuessTheListRealtime({
  gameId,
  playerNumber,
  onMessage,
  onClose,
  WebSocketImpl,
  authToken,
}) {
  return connectRealtimeWebSocket(
    `/quiz/guess-the-list/ws/${gameId}?player=${playerNumber}`,
    { onMessage, onClose, WebSocketImpl, authToken }
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

// ---------------------------------------------------------------------------
// Career Quiz API
// ---------------------------------------------------------------------------

export function createCareerSoloRound(recentPlayerIds = []) {
  return request("POST", "/quiz/career/solo/round", {
    recent_player_ids: recentPlayerIds,
  });
}

export function submitCareerSoloGuess(roundToken, playerId) {
  return request("POST", "/quiz/career/solo/guess", {
    round_token: roundToken,
    player_id: playerId,
  });
}

export function revealCareerSoloAnswer(roundToken) {
  return request("POST", "/quiz/career/solo/reveal", {
    round_token: roundToken,
  });
}

export function fetchCareerSoloHint(roundToken, progress = {}) {
  return request("POST", "/quiz/career/solo/hint", {
    round_token: roundToken,
    shown_hints: progress.shown_hints || [],
    revealed_letters: progress.revealed_letters || [],
  });
}

export function autocompleteCareerPlayer(q, limit = 15) {
  const params = new URLSearchParams({ q, limit });
  return request("GET", `/quiz/career/players/autocomplete?${params}`);
}

export function createCareerGame(payload) {
  return actionRequest("POST", "/quiz/career/games", { ...payload, guest_id: getGuestId() });
}

export function getCareerGame(gameId) {
  return request("GET", `/quiz/career/games/${gameId}`);
}

export function joinCareerGame(joinCode, playerName) {
  return actionRequest("POST", "/quiz/career/games/join", {
    join_code: joinCode,
    player_name: playerName,
    guest_id: getGuestId(),
  });
}

export function careerQuickMatch(payload) {
  return actionRequest("POST", "/quiz/career/quick-match", {
    ...payload,
    guest_id: getGuestId(),
  });
}

export function cancelCareerQuickMatch(payload) {
  return actionRequest("POST", "/quiz/career/quick-match/cancel", {
    ...payload,
    guest_id: getGuestId(),
  });
}

export function getCareerQuickMatchPools() {
  return request("GET", "/quiz/career/quick-match/pools");
}

export function submitCareerGuess(gameId, playerNumber, playerId, roundNumber) {
  return actionRequest("POST", `/quiz/career/games/${gameId}/guess?player=${playerNumber}`, {
    player_id: playerId,
    round_number: roundNumber,
  });
}

export function resignCareerGame(gameId, playerNumber) {
  return actionRequest("POST", `/quiz/career/games/${gameId}/give-up?player=${playerNumber}`);
}

export function offerCareerNoAnswer(gameId, playerNumber, roundNumber) {
  return actionRequest("POST", `/quiz/career/games/${gameId}/no-answer-offer?player=${playerNumber}`, {
    round_number: roundNumber,
  });
}

export function respondCareerNoAnswer(gameId, playerNumber, accept, roundNumber) {
  return actionRequest("POST", `/quiz/career/games/${gameId}/no-answer-response?player=${playerNumber}`, {
    accept,
    round_number: roundNumber,
  });
}

export function connectCareerRealtime({
  gameId,
  playerNumber,
  onMessage,
  onClose,
  WebSocketImpl,
  authToken,
}) {
  return connectRealtimeWebSocket(
    `/quiz/career/ws/${gameId}?player=${playerNumber}`,
    { onMessage, onClose, WebSocketImpl, authToken }
  );
}

// ---------------------------------------------------------------------------
// Photo Quiz API
// ---------------------------------------------------------------------------

export function createPhotoSoloRound(recentPlayerIds = []) {
  return request("POST", "/quiz/photo/solo/round", {
    recent_player_ids: recentPlayerIds,
  });
}

export function submitPhotoSoloGuess(roundToken, playerId) {
  return request("POST", "/quiz/photo/solo/guess", {
    round_token: roundToken,
    player_id: playerId,
  });
}

export function revealPhotoSoloAnswer(roundToken) {
  return request("POST", "/quiz/photo/solo/reveal", {
    round_token: roundToken,
  });
}

export function autocompletePhotoPlayer(q, limit = 15) {
  const params = new URLSearchParams({ q, limit });
  return request("GET", `/quiz/photo/players/autocomplete?${params}`);
}

export function createPhotoGame(payload) {
  return actionRequest("POST", "/quiz/photo/games", { ...payload, guest_id: getGuestId() });
}

export function getPhotoGame(gameId) {
  return request("GET", `/quiz/photo/games/${gameId}`);
}

export function joinPhotoGame(joinCode, playerName) {
  return actionRequest("POST", "/quiz/photo/games/join", {
    join_code: joinCode,
    player_name: playerName,
    guest_id: getGuestId(),
  });
}

export function submitPhotoGuess(gameId, playerNumber, playerId, roundNumber) {
  return actionRequest("POST", `/quiz/photo/games/${gameId}/guess?player=${playerNumber}`, {
    player_id: playerId,
    round_number: roundNumber,
  });
}

export function resignPhotoGame(gameId, playerNumber) {
  return actionRequest("POST", `/quiz/photo/games/${gameId}/give-up?player=${playerNumber}`);
}

export function offerPhotoNoAnswer(gameId, playerNumber, roundNumber) {
  return actionRequest("POST", `/quiz/photo/games/${gameId}/no-answer-offer?player=${playerNumber}`, {
    round_number: roundNumber,
  });
}

export function respondPhotoNoAnswer(gameId, playerNumber, accept, roundNumber, offerVersion) {
  return actionRequest("POST", `/quiz/photo/games/${gameId}/no-answer-response?player=${playerNumber}`, {
    accept,
    round_number: roundNumber,
    no_answer_offer_version: offerVersion,
  });
}

export function photoQuickMatch(payload) {
  return actionRequest("POST", "/quiz/photo/quick-match", {
    ...payload,
    guest_id: getGuestId(),
  });
}

export function cancelPhotoQuickMatch(payload) {
  return actionRequest("POST", "/quiz/photo/quick-match/cancel", {
    ...payload,
    guest_id: getGuestId(),
  });
}

export function getPhotoQuickMatchPools() {
  return request("GET", "/quiz/photo/quick-match/pools");
}

export function connectPhotoRealtime({
  gameId,
  playerNumber,
  onMessage,
  onClose,
  WebSocketImpl,
  authToken,
}) {
  return connectRealtimeWebSocket(
    `/quiz/photo/ws/${gameId}?player=${playerNumber}`,
    { onMessage, onClose, WebSocketImpl, authToken }
  );
}
