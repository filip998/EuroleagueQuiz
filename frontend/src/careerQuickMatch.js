import { getCareerQuickMatchPools } from "./api";
import { useQuickMatchPoolsFrom } from "./quickMatch";

// Career Quiz Quick Match preset metadata. Keys must match the backend
// matchmaking presets (see backend/app/services/matchmaking_adapters.py):
// quick = first to 1, standard = first to 3, long = first to 5. All presets use
// private wrong guesses and a 20-second per-round timer.
export const CAREER_QUICK_MATCH_PRESETS = [
  { key: "quick", label: "First to 1", detail: "First to win a round · 20s" },
  { key: "standard", label: "First to 3", detail: "First to 3 wins · 20s" },
  { key: "long", label: "First to 5", detail: "First to 5 wins · 20s" },
];

export const DEFAULT_CAREER_QUICK_MATCH_PRESET = "standard";

// The backend gives each public round a 20-second timer; the board mirrors it
// client-side because the realtime layer does not push a per-round deadline.
export const CAREER_QUICK_MATCH_ROUND_SECONDS = 20;

export function careerPresetLabel(key) {
  return CAREER_QUICK_MATCH_PRESETS.find((p) => p.key === key)?.label || key;
}

export function useCareerQuickMatchPools(enabled) {
  return useQuickMatchPoolsFrom(enabled, getCareerQuickMatchPools);
}

// Namespace durable Quick Match seat keys so a Career game id can't collide with
// other games that happen to share the same numeric id in the shared seat map.
export function careerSeatKey(gameId) {
  return `career:${gameId}`;
}
