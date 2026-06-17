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

// Fallback used only when localStorage cannot retain the seat map (private mode,
// quota, disabled storage). Mirrors the guest-id fallback in identity.js: the
// quick-match response never states the seat, so a stable guest re-entering
// their own active game would otherwise mis-infer player 2 from the active
// status. Keeping the map in memory holds the first-resolved seat for the page
// lifetime so re-entry stays seated correctly even without storage.
let memorySeats = null;

function readSeats() {
  try {
    const raw = globalThis.localStorage?.getItem(SEATS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Storage threw — reuse the in-memory copy a prior write couldn't persist.
    return memorySeats ? { ...memorySeats } : {};
  }
}

function writeSeats(seats) {
  let persisted = false;
  try {
    globalThis.localStorage?.setItem(SEATS_KEY, JSON.stringify(seats));
    persisted =
      globalThis.localStorage?.getItem(SEATS_KEY) === JSON.stringify(seats);
  } catch {
    persisted = false;
  }
  // Shadow the map in memory only while storage refuses to retain it. A working
  // backend resets the shadow on every successful write, so it never leaks.
  memorySeats = persisted ? null : { ...seats };
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

// Drop a game's recorded seat. Called when a quick-match search is cancelled and
// the backend deletes the waiting row: SQLite can reuse that id for a later game,
// and the first-write-wins map would otherwise mis-seat the new game.
export function forgetQuickMatchSeat(gameId) {
  if (gameId == null) return;
  const key = String(gameId);
  const seats = readSeats();
  if (!(key in seats)) return;
  delete seats[key];
  writeSeats(seats);
}

// Resolve the seat for a freshly returned quick-match game: prefer a recorded
// seat, otherwise infer from status, and record the result first-write-wins.
export function resolveQuickMatchSeat(gameId, status) {
  const recalled = recallQuickMatchSeat(gameId);
  const seat = recalled ?? (status === "active" ? 2 : 1);
  return rememberQuickMatchSeat(gameId, seat) ?? seat;
}
