import { getGuessTheListRaceQuickMatchPools } from "./api";
import { useQuickMatchPoolsFrom } from "./quickMatch";

const ERAS = [
  { key: "full", label: "Full era", detail: "2000-2025" },
  { key: "modern", label: "Modern", detail: "2018-2025" },
  { key: "nostalgia", label: "Nostalgia", detail: "2000-2010" },
  { key: "recent", label: "Recent", detail: "2010-2025" },
];

const LENGTHS = [
  { key: "quick", label: "Best of 1", detail: "First to 1", targetWins: 1 },
  { key: "standard", label: "Best of 3", detail: "First to 2", targetWins: 2 },
  { key: "long", label: "Best of 5", detail: "First to 3", targetWins: 3 },
];

export const GUESS_THE_LIST_RACE_QUICK_MATCH_PRESETS = ERAS.flatMap((era) =>
  LENGTHS.map((length) => ({
    key: `${era.key}-${length.key}`,
    label: `${era.label} · ${length.label}`,
    detail: `${era.detail} · ${length.detail} · 120s rounds`,
    era: era.key,
    targetWins: length.targetWins,
  }))
);

export const DEFAULT_GUESS_THE_LIST_RACE_QUICK_MATCH_PRESET = "modern-standard";
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
