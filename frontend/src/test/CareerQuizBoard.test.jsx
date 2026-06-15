import { describe, expect, it } from "vitest";
import { formatSeasonRange, shouldRevealCompletedRound } from "../CareerQuizBoard";

describe("formatSeasonRange", () => {
  it("prefers Wikipedia-style years when provided", () => {
    expect(formatSeasonRange({
      years: "1999\u20132004",
      start_season: "1999/00",
      end_season: "2003/04",
    })).toBe("1999\u20132004");
  });

  it("shows a single Wikipedia year", () => {
    expect(formatSeasonRange({ years: "2010" })).toBe("2010");
  });

  it("shows open-ended current stints in Wikipedia style", () => {
    expect(formatSeasonRange({ years: "2024\u2013present" })).toBe("2024\u2013present");
  });

  it("falls back to season labels when years missing", () => {
    expect(formatSeasonRange({
      start_season: "2020/21",
      end_season: "2020/21",
    })).toBe("2020/21");
    expect(formatSeasonRange({
      start_season: "2023/24",
      end_season: null,
    })).toBe("2023/24 \u2013 present");
  });
});

describe("shouldRevealCompletedRound", () => {
  it("does not reveal when no completed round is available", () => {
    expect(shouldRevealCompletedRound(null, null)).toBe(false);
  });

  it("reveals a new completed round once", () => {
    expect(shouldRevealCompletedRound({ round_number: 2 }, 1)).toBe(true);
    expect(shouldRevealCompletedRound({ round_number: 2 }, 2)).toBe(false);
  });
});
