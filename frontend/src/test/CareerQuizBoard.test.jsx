import { describe, expect, it } from "vitest";
import { formatSeasonRange } from "../CareerQuizBoard";

describe("formatSeasonRange", () => {
  it("collapses one-season stints", () => {
    expect(formatSeasonRange({
      start_season: "2020/21",
      end_season: "2020/21",
    })).toBe("2020/21");
  });

  it("clamps invalid displayed ranges to the start season", () => {
    expect(formatSeasonRange({
      start_season: "2021/22",
      end_season: "2020/21",
    })).toBe("2021/22");
  });

  it("shows open-ended current stints", () => {
    expect(formatSeasonRange({
      start_season: "2023/24",
      end_season: null,
    })).toBe("2023/24 - now");
  });
});
