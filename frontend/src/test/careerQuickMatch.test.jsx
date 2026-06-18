import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  CAREER_QUICK_MATCH_PRESETS,
  DEFAULT_CAREER_QUICK_MATCH_PRESET,
  CAREER_QUICK_MATCH_ROUND_SECONDS,
  careerPresetLabel,
  careerSeatKey,
  useCareerQuickMatchPools,
} from "../careerQuickMatch";
import { getCareerQuickMatchPools } from "../api";

vi.mock("../api", () => ({
  getCareerQuickMatchPools: vi.fn(),
}));

const fetchMock = vi.mocked(getCareerQuickMatchPools);

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("career preset metadata", () => {
  it("exposes the three backend presets and a valid default", () => {
    expect(CAREER_QUICK_MATCH_PRESETS.map((p) => p.key)).toEqual([
      "quick",
      "standard",
      "long",
    ]);
    expect(CAREER_QUICK_MATCH_PRESETS.map((p) => p.key)).toContain(
      DEFAULT_CAREER_QUICK_MATCH_PRESET
    );
  });

  it("labels the presets as First to 1/3/5", () => {
    expect(careerPresetLabel("quick")).toBe("First to 1");
    expect(careerPresetLabel("standard")).toBe("First to 3");
    expect(careerPresetLabel("long")).toBe("First to 5");
  });

  it("falls back to the key for unknown presets", () => {
    expect(careerPresetLabel("mystery")).toBe("mystery");
  });

  it("uses a 20 second per-round window", () => {
    expect(CAREER_QUICK_MATCH_ROUND_SECONDS).toBe(20);
  });
});

describe("careerSeatKey", () => {
  it("namespaces seat keys so they cannot collide with raw game ids", () => {
    expect(careerSeatKey(7)).toBe("career:7");
    expect(careerSeatKey("ABC")).toBe("career:ABC");
  });
});

describe("useCareerQuickMatchPools", () => {
  it("does not poll when disabled", () => {
    const { result } = renderHook(() => useCareerQuickMatchPools(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.pools).toBeNull();
  });

  it("polls the career pools endpoint and exposes the counts when enabled", async () => {
    fetchMock.mockResolvedValue({
      pools: { standard: { searching: 4, in_progress: 1 } },
      poll_interval_seconds: 5,
    });

    const { result, unmount } = renderHook(() => useCareerQuickMatchPools(true));

    await waitFor(() => expect(result.current.pools).not.toBeNull());
    expect(fetchMock).toHaveBeenCalled();
    expect(result.current.pools.standard.searching).toBe(4);
    unmount();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ pools: {}, poll_interval_seconds: 1 });

    const { unmount } = renderHook(() => useCareerQuickMatchPools(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    const callsWhileMounted = fetchMock.mock.calls.length;
    expect(callsWhileMounted).toBeGreaterThanOrEqual(2);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetchMock.mock.calls.length).toBe(callsWhileMounted);
  });
});
