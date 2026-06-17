// Persist and recover an online game's seat across page refreshes and tabs.
//
// Per-tab sessionStorage is the authoritative source: the seat (`playerNumber`)
// is written when the game is created/joined. When it's missing — e.g. the game
// URL was opened in a fresh tab — TicTacToe falls back to the durable Quick Match
// seat map so quick-matched games resume as the correct player rather than as a
// local game (which would mishandle the disconnect forfeit).

import { recallQuickMatchSeat } from "./quickMatchSeats";

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

export function recoverOnlineInfo(gameId, game) {
  const stored = loadOnlineInfo(gameId);
  if (stored) return stored;
  if (game?.mode === "online_friend") {
    const seat = recallQuickMatchSeat(gameId);
    if (seat) return { playerNumber: seat, isOnline: true };
  }
  return null;
}
