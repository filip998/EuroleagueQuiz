// Persist and recover an online game's seat across page refreshes and tabs.
//
// Per-tab sessionStorage is the authoritative source: the seat (`playerNumber`)
// is written when the game is created/joined. When it's missing — e.g. the game
// URL was opened in a fresh tab — TicTacToe falls back to the durable Quick Match
// seat map so quick-matched games resume as the correct player rather than as a
// local game (which would mishandle the disconnect forfeit).

import { recallQuickMatchSeat } from "./quickMatchSeats";
import { careerSeatKey } from "./careerQuickMatch";
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

// Only an actually-online game (`mode === "online_friend"`) is ever recovered as
// online. A solo (`single_player`) or local (`local_two_player`) game must never
// be treated as online, even if a stale `elq_game_<id>` seat lingers from an
// earlier online game whose numeric id was later reused (the tracked prod DB is
// reseeded/redeployed, which restarts game ids). The seat key is NOT namespaced
// per board, so a live online game of another type can legitimately share this
// numeric id in the same tab — we therefore refuse to honor the seat here but do
// not clear it (clearing could drop that other game's seat).
export function recoverOnlineInfo(gameId, game) {
  if (game?.mode !== "online_friend") return null;
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  const seat = recallQuickMatchSeat(gameId);
  if (seat) return { playerNumber: seat, isOnline: true };
  return null;
}

// Photo Quiz recovery. Per-tab sessionStorage is authoritative; only public
// Quick Match games fall back to the durable seat map (under a photo-namespaced
// key). Private friend games never fall back — a fresh tab joins via the URL —
// so they can't be mis-seated from a stale namespaced entry.
export function recoverPhotoOnlineInfo(gameId, game) {
  if (game?.mode !== "online_friend") return null;
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  if (game?.is_public && game?.preset) {
    const seat = recallQuickMatchSeat(photoSeatKey(gameId));
    if (seat) return { playerNumber: seat, isOnline: true };
  }
  return null;
}

export function recoverCareerOnlineInfo(gameId, game) {
  if (game?.mode !== "online_friend") return null;
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  if (game?.is_public && game?.preset) {
    const seat = recallQuickMatchSeat(careerSeatKey(gameId));
    if (seat) return { playerNumber: seat, isOnline: true };
  }
  return null;
}

export function recoverRosterOnlineInfo(gameId, game) {
  if (game?.mode !== "online_friend") return null;
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  if (game?.is_race && game?.is_public && game?.preset) {
    const seat = recallQuickMatchSeat(rosterRaceSeatKey(gameId));
    if (seat) return { playerNumber: seat, isOnline: true };
  }
  return null;
}
