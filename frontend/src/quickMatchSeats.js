// Durable per-game seat memory for TicTacToe Quick Match.
//
// The quick-match response never tells the client which player it is, so the
// caller infers the seat from game.status (waiting -> player 1, active ->
// player 2). That inference is wrong in one case: matchmaking can return a
// pre-existing ACTIVE game where this guest is actually player 1. Because
// matchmaking only ever returns a game tied to *this* guest_id (kept in
// localStorage), any such game was necessarily created/joined by this same
// browser, which means its seat was already recorded here. So consulting this
// localStorage-backed, first-write-wins map before trusting the inference makes
// seat resolution correct across same-tab re-entry, multiple tabs, and fresh
// tabs recovering an in-progress game. It degrades to pure inference when
// storage is unavailable.

const SEATS_KEY = "elq_qm_seats";
const MAX_ENTRIES = 25;

function readSeats() {
  try {
    const raw = globalThis.localStorage?.getItem(SEATS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSeats(seats) {
  try {
    globalThis.localStorage?.setItem(SEATS_KEY, JSON.stringify(seats));
  } catch {
    // Storage unavailable (private mode, quota, disabled) — seat memory simply
    // degrades to status inference.
  }
}

function normalizeSeat(value) {
  return value === 1 || value === 2 ? value : null;
}

export function recallQuickMatchSeat(gameId) {
  if (gameId == null) return null;
  const seats = readSeats();
  return normalizeSeat(seats[String(gameId)]);
}

export function rememberQuickMatchSeat(gameId, playerNumber) {
  const seat = normalizeSeat(playerNumber);
  if (gameId == null || seat == null) return seat;
  const key = String(gameId);
  const seats = readSeats();
  // First write wins: a seat never changes for a given game, so never let a
  // later (possibly mis-inferred) value overwrite a known-good seat.
  if (normalizeSeat(seats[key]) != null) return seats[key];

  seats[key] = seat;

  const keys = Object.keys(seats);
  if (keys.length > MAX_ENTRIES) {
    // Drop the oldest entries (insertion order) to keep the map bounded.
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete seats[stale];
    }
  }

  writeSeats(seats);
  return seat;
}

// Resolve the seat for a freshly returned quick-match game: prefer a recorded
// seat, otherwise infer from status, and record the result first-write-wins.
export function resolveQuickMatchSeat(gameId, status) {
  const recalled = recallQuickMatchSeat(gameId);
  const seat = recalled ?? (status === "active" ? 2 : 1);
  return rememberQuickMatchSeat(gameId, seat) ?? seat;
}
