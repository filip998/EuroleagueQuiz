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
import {
  guessTheListRaceSeatKey,
  legacyGuessTheListRaceSeatKey,
} from "./guessTheListRaceQuickMatch";

export function saveOnlineInfo(gameId, online) {
  const normalized = normalizeOnlineInfo(online);
  if (!normalized) return;
  try {
    sessionStorage.setItem(
      `elq_game_${gameId}`,
      JSON.stringify(normalized)
    );
  } catch {
    // Storage may be unavailable (private mode, quota); recovery degrades to the
    // seat map or a fresh load rather than breaking game creation.
  }
}

export function loadOnlineInfo(gameId) {
  try {
    const stored = sessionStorage.getItem(`elq_game_${gameId}`);
    return stored ? normalizeOnlineInfo(JSON.parse(stored)) : null;
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

function normalizePlayerNumber(value) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return parsed === 1 || parsed === 2 ? parsed : null;
}

function normalizeOnlineInfo(online) {
  if (!online || online.isOnline !== true) return null;
  const playerNumber = normalizePlayerNumber(online.playerNumber);
  if (playerNumber == null) return null;
  return { playerNumber, isOnline: true };
}

function onlineInfoFromSeat(seat) {
  const playerNumber = normalizePlayerNumber(seat);
  return playerNumber == null ? null : { playerNumber, isOnline: true };
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
  return onlineInfoFromSeat(recallQuickMatchSeat(gameId));
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
    return onlineInfoFromSeat(recallQuickMatchSeat(photoSeatKey(gameId)));
  }
  return null;
}

export function recoverCareerOnlineInfo(gameId, game) {
  if (game?.mode !== "online_friend") return null;
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  if (game?.is_public && game?.preset) {
    return onlineInfoFromSeat(recallQuickMatchSeat(careerSeatKey(gameId)));
  }
  return null;
}

export function recoverGuessTheListOnlineInfo(gameId, game) {
  if (game?.mode !== "online_friend") return null;
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  if (game?.is_race && game?.is_public && game?.preset) {
    const seat =
      recallQuickMatchSeat(guessTheListRaceSeatKey(gameId))
      ?? recallQuickMatchSeat(legacyGuessTheListRaceSeatKey(gameId));
    return onlineInfoFromSeat(seat);
  }
  return null;
}
