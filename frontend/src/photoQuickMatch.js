import { getPhotoQuickMatchPools } from "./api";
import { useQuickMatchPoolsFrom } from "./quickMatch";

// Photo Quiz Quick Match preset metadata. Keys must match the backend
// matchmaking presets (see backend/app/services/matchmaking_adapters.py):
// quick = first to 1, standard = first to 3, long = first to 5. All presets use
// private wrong guesses and a 60-second per-round timer.
export const PHOTO_QUICK_MATCH_PRESETS = [
  { key: "quick", label: "First to 1", detail: "First to win a round · 60s" },
  { key: "standard", label: "First to 3", detail: "First to 3 wins · 60s" },
  { key: "long", label: "First to 5", detail: "First to 5 wins · 60s" },
];

export const DEFAULT_PHOTO_QUICK_MATCH_PRESET = "standard";

// The backend gives each public round a 60-second timer; the board mirrors it
// client-side because the realtime layer does not push a per-round deadline.
export const PHOTO_QUICK_MATCH_ROUND_SECONDS = 60;

export function photoPresetLabel(key) {
  return PHOTO_QUICK_MATCH_PRESETS.find((p) => p.key === key)?.label || key;
}

export function usePhotoQuickMatchPools(enabled) {
  return useQuickMatchPoolsFrom(enabled, getPhotoQuickMatchPools);
}

// Namespace durable Quick Match seat keys so a Photo game id can't collide with
// a TicTacToe game that happens to share the same numeric id in the shared
// localStorage seat map.
export function photoSeatKey(gameId) {
  return `photo:${gameId}`;
}
