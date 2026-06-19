import { getGuessTheListRaceQuickMatchPools } from "./api";
import { useQuickMatchPoolsFrom } from "./quickMatch";

const LENGTHS = [
  {
    key: "quick",
    label: "Quick",
    detail: "First to 1 · mixed lists · 120s rounds",
    targetWins: 1,
  },
  {
    key: "standard",
    label: "Standard",
    detail: "First to 2 · mixed lists · 120s rounds",
    targetWins: 2,
  },
  {
    key: "long",
    label: "Long",
    detail: "First to 3 · mixed lists · 120s rounds",
    targetWins: 3,
  },
];

export const GUESS_THE_LIST_RACE_QUICK_MATCH_PRESETS = LENGTHS;

export const DEFAULT_GUESS_THE_LIST_RACE_QUICK_MATCH_PRESET = "standard";
export const GUESS_THE_LIST_RACE_ROUND_SECONDS = 120;

export function guessTheListRacePresetLabel(key) {
  return GUESS_THE_LIST_RACE_QUICK_MATCH_PRESETS.find((preset) => preset.key === key)?.label || key;
}

export function useGuessTheListRaceQuickMatchPools(enabled) {
  return useQuickMatchPoolsFrom(enabled, getGuessTheListRaceQuickMatchPools);
}

export function guessTheListRaceSeatKey(gameId) {
  return `guess-the-list-race:${gameId}`;
}

export function legacyGuessTheListRaceSeatKey(gameId) {
  return `roster-race:${gameId}`;
}
