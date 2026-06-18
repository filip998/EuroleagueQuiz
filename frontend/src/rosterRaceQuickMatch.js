import { getRosterRaceQuickMatchPools } from "./api";
import { useQuickMatchPoolsFrom } from "./quickMatch";

const ERA_LABELS = {
  full: "Full era",
  modern: "Modern era",
  nostalgia: "Nostalgia",
  recent: "Recent era",
};

const ERA_DETAILS = {
  full: "2000-2025",
  modern: "2018-2025",
  nostalgia: "2000-2010",
  recent: "2010-2025",
};

const LENGTHS = [
  ["quick", "First to 1", 1],
  ["standard", "First to 3", 3],
  ["long", "First to 5", 5],
];

export const ROSTER_RACE_QUICK_MATCH_PRESETS = Object.keys(ERA_LABELS).flatMap((era) =>
  LENGTHS.map(([length, lengthLabel, wins]) => ({
    key: `${era}-${length}`,
    label: `${ERA_LABELS[era]} · ${lengthLabel}`,
    detail: `${ERA_DETAILS[era]} · ${wins === 1 ? "1 round win" : `${wins} round wins`} · 120s`,
  }))
);

export const DEFAULT_ROSTER_RACE_QUICK_MATCH_PRESET = "modern-standard";
export const ROSTER_RACE_ROUND_SECONDS = 120;

export function rosterRacePresetLabel(key) {
  return ROSTER_RACE_QUICK_MATCH_PRESETS.find((p) => p.key === key)?.label || key;
}

export function useRosterRaceQuickMatchPools(enabled) {
  return useQuickMatchPoolsFrom(enabled, getRosterRaceQuickMatchPools);
}

export function rosterRaceSeatKey(gameId) {
  return `roster:${gameId}`;
}
