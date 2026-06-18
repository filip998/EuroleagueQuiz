import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUESS_THE_LIST_RACE_QUICK_MATCH_PRESET,
  GUESS_THE_LIST_RACE_QUICK_MATCH_PRESETS,
  guessTheListRacePresetLabel,
} from "../guessTheListRaceQuickMatch";

describe("Guess the List Race quick match presets", () => {
  it("defines the three length-only pools expected by the backend", () => {
    expect(GUESS_THE_LIST_RACE_QUICK_MATCH_PRESETS.map((preset) => preset.key)).toEqual([
      "quick",
      "standard",
      "long",
    ]);
    expect(DEFAULT_GUESS_THE_LIST_RACE_QUICK_MATCH_PRESET).toBe("standard");
    expect(guessTheListRacePresetLabel("standard")).toBe("Standard");
  });
});
