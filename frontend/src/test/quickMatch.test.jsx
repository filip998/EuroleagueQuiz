import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  formatPresence,
  presetLabel,
  useQuickMatchPools,
  QUICK_MATCH_PRESETS,
  DEFAULT_QUICK_MATCH_PRESET,
} from "../quickMatch";
import { fetchTicTacToeQuickMatchPools } from "../api";

vi.mock("../api", () => ({
  fetchTicTacToeQuickMatchPools: vi.fn(),
}));

const fetchMock = vi.mocked(fetchTicTacToeQuickMatchPools);

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("preset metadata", () => {
  it("exposes the three backend presets and a valid default", () => {
    expect(QUICK_MATCH_PRESETS.map((p) => p.key)).toEqual(["blitz", "standard", "long"]);
    expect(QUICK_MATCH_PRESETS.map((p) => p.key)).toContain(DEFAULT_QUICK_MATCH_PRESET);
  });
});

describe("formatPresence", () => {
  it("formats searching and in-progress counts", () => {
    expect(formatPresence({ searching: 2, in_progress: 5 })).toBe(
      "2 searching · 5 in progress"
    );
  });

  it("defaults missing counts to zero", () => {
    expect(formatPresence(null)).toBe("0 searching · 0 in progress");
    expect(formatPresence(undefined)).toBe("0 searching · 0 in progress");
  });
});

describe("presetLabel", () => {
  it("maps a preset key to its label", () => {
    expect(presetLabel("blitz")).toBe("Blitz");
    expect(presetLabel("long")).toBe("Long");
  });

  it("falls back to the key for unknown presets", () => {
    expect(presetLabel("mystery")).toBe("mystery");
  });
});

describe("useQuickMatchPools", () => {
  it("does not poll when disabled", () => {
    const { result } = renderHook(() => useQuickMatchPools(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.pools).toBeNull();
  });

  it("polls immediately and exposes the pools when enabled", async () => {
    fetchMock.mockResolvedValue({
      pools: { blitz: { searching: 3, in_progress: 2 } },
      poll_interval_seconds: 5,
    });

    const { result, unmount } = renderHook(() => useQuickMatchPools(true));

    await waitFor(() => expect(result.current.pools).not.toBeNull());
    expect(fetchMock).toHaveBeenCalled();
    expect(result.current.pools.blitz.searching).toBe(3);
    unmount();
  });

  it("keeps the previous pools and retries when a poll fails", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    const { result, unmount } = renderHook(() => useQuickMatchPools(true));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.pools).toBeNull();
    unmount();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ pools: {}, poll_interval_seconds: 1 });

    const { unmount } = renderHook(() => useQuickMatchPools(true));
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
