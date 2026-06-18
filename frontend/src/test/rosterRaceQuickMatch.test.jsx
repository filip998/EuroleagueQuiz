import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  DEFAULT_ROSTER_RACE_QUICK_MATCH_PRESET,
  ROSTER_RACE_QUICK_MATCH_PRESETS,
  ROSTER_RACE_ROUND_SECONDS,
  rosterRacePresetLabel,
  rosterRaceSeatKey,
  useRosterRaceQuickMatchPools,
} from "../rosterRaceQuickMatch";
import { getRosterRaceQuickMatchPools } from "../api";

vi.mock("../api", () => ({
  getRosterRaceQuickMatchPools: vi.fn(),
}));

const fetchMock = vi.mocked(getRosterRaceQuickMatchPools);

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("roster race preset metadata", () => {
  it("exposes the 12 era/length backend presets and a valid default", () => {
    expect(ROSTER_RACE_QUICK_MATCH_PRESETS).toHaveLength(12);
    expect(ROSTER_RACE_QUICK_MATCH_PRESETS.map((p) => p.key)).toEqual([
      "full-quick",
      "full-standard",
      "full-long",
      "modern-quick",
      "modern-standard",
      "modern-long",
      "nostalgia-quick",
      "nostalgia-standard",
      "nostalgia-long",
      "recent-quick",
      "recent-standard",
      "recent-long",
    ]);
    expect(ROSTER_RACE_QUICK_MATCH_PRESETS.map((p) => p.key)).toContain(
      DEFAULT_ROSTER_RACE_QUICK_MATCH_PRESET
    );
  });

  it("labels known presets and falls back to the key for unknown presets", () => {
    expect(rosterRacePresetLabel("modern-standard")).toBe("Modern era · First to 3");
    expect(rosterRacePresetLabel("mystery")).toBe("mystery");
  });

  it("uses a 120 second race-round window", () => {
    expect(ROSTER_RACE_ROUND_SECONDS).toBe(120);
  });
});

describe("rosterRaceSeatKey", () => {
  it("namespaces Roster Race seats", () => {
    expect(rosterRaceSeatKey(7)).toBe("roster:7");
    expect(rosterRaceSeatKey("ABC")).toBe("roster:ABC");
  });
});

describe("useRosterRaceQuickMatchPools", () => {
  it("does not poll when disabled", () => {
    const { result } = renderHook(() => useRosterRaceQuickMatchPools(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.pools).toBeNull();
  });

  it("polls the roster pools endpoint and exposes the counts when enabled", async () => {
    fetchMock.mockResolvedValue({
      pools: { "modern-standard": { searching: 4, in_progress: 1 } },
      poll_interval_seconds: 5,
    });

    const { result, unmount } = renderHook(() => useRosterRaceQuickMatchPools(true));

    await waitFor(() => expect(result.current.pools).not.toBeNull());
    expect(fetchMock).toHaveBeenCalled();
    expect(result.current.pools["modern-standard"].searching).toBe(4);
    unmount();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ pools: {}, poll_interval_seconds: 1 });

    const { unmount } = renderHook(() => useRosterRaceQuickMatchPools(true));
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
