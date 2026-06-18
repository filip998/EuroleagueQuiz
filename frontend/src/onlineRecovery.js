// Persist and recover an online game's seat across page refreshes and tabs.
//
// Per-tab sessionStorage is the authoritative source: the seat (`playerNumber`)
// is written when the game is created/joined. When it's missing — e.g. the game
// URL was opened in a fresh tab — TicTacToe falls back to the durable Quick Match
// seat map so quick-matched games resume as the correct player rather than as a
// local game (which would mishandle the disconnect forfeit).

import { recallQuickMatchSeat } from "./quickMatchSeats";
import { photoSeatKey } from "./photoQuickMatch";
import { rosterRaceSeatKey } from "./rosterRaceQuickMatch";

export function saveOnlineInfo(gameId, online) {
  if (!online) return;
  try {
    sessionStorage.setItem(
      `elq_game_${gameId}`,
      JSON.stringify({ playerNumber: online.playerNumber, isOnline: true })
    );
  } catch {
    // Storage may be unavailable (private mode, quota); recovery degrades to the
    // seat map or a fresh load rather than breaking game creation.
  }
}

export function loadOnlineInfo(gameId) {
  try {
    const stored = sessionStorage.getItem(`elq_game_${gameId}`);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function clearOnlineInfo(gameId) {
  try {
    sessionStorage.removeItem(`elq_game_${gameId}`);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

export function recoverOnlineInfo(gameId, game) {
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  if (game?.mode === "online_friend") {
    const seat = recallQuickMatchSeat(gameId);
    if (seat) return { playerNumber: seat, isOnline: true };
  }
  return null;
}

// Photo Quiz recovery. Per-tab sessionStorage is authoritative; only public
// Quick Match games fall back to the durable seat map (under a photo-namespaced
// key). Private friend games never fall back — a fresh tab joins via the URL —
// so they can't be mis-seated from a stale namespaced entry.
export function recoverPhotoOnlineInfo(gameId, game) {
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  if (game?.mode === "online_friend" && game?.is_public && game?.preset) {
    const seat = recallQuickMatchSeat(photoSeatKey(gameId));
    if (seat) return { playerNumber: seat, isOnline: true };
  }
  return null;
}

export function recoverRosterOnlineInfo(gameId, game) {
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  if (game?.mode === "online_friend" && game?.is_race && game?.is_public && game?.preset) {
    const seat = recallQuickMatchSeat(rosterRaceSeatKey(gameId));
    if (seat) return { playerNumber: seat, isOnline: true };
  }
  return null;
}
