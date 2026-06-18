import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  PHOTO_QUICK_MATCH_PRESETS,
  DEFAULT_PHOTO_QUICK_MATCH_PRESET,
  PHOTO_QUICK_MATCH_ROUND_SECONDS,
  photoPresetLabel,
  photoSeatKey,
  usePhotoQuickMatchPools,
} from "../photoQuickMatch";
import { getPhotoQuickMatchPools } from "../api";

vi.mock("../api", () => ({
  getPhotoQuickMatchPools: vi.fn(),
}));

const fetchMock = vi.mocked(getPhotoQuickMatchPools);

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("photo preset metadata", () => {
  it("exposes the three backend presets and a valid default", () => {
    expect(PHOTO_QUICK_MATCH_PRESETS.map((p) => p.key)).toEqual([
      "quick",
      "standard",
      "long",
    ]);
    expect(PHOTO_QUICK_MATCH_PRESETS.map((p) => p.key)).toContain(
      DEFAULT_PHOTO_QUICK_MATCH_PRESET
    );
  });

  it("labels the presets as First to 1/3/5", () => {
    expect(photoPresetLabel("quick")).toBe("First to 1");
    expect(photoPresetLabel("standard")).toBe("First to 3");
    expect(photoPresetLabel("long")).toBe("First to 5");
  });

  it("falls back to the key for unknown presets", () => {
    expect(photoPresetLabel("mystery")).toBe("mystery");
  });

  it("uses a 10 second per-round window", () => {
    expect(PHOTO_QUICK_MATCH_ROUND_SECONDS).toBe(10);
  });
});

describe("photoSeatKey", () => {
  it("namespaces seat keys so they cannot collide with raw TicTacToe ids", () => {
    expect(photoSeatKey(7)).toBe("photo:7");
    expect(photoSeatKey("ABC")).toBe("photo:ABC");
  });
});

describe("usePhotoQuickMatchPools", () => {
  it("does not poll when disabled", () => {
    const { result } = renderHook(() => usePhotoQuickMatchPools(false));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.pools).toBeNull();
  });

  it("polls the photo pools endpoint and exposes the counts when enabled", async () => {
    fetchMock.mockResolvedValue({
      pools: { standard: { searching: 4, in_progress: 1 } },
      poll_interval_seconds: 5,
    });

    const { result, unmount } = renderHook(() => usePhotoQuickMatchPools(true));

    await waitFor(() => expect(result.current.pools).not.toBeNull());
    expect(fetchMock).toHaveBeenCalled();
    expect(result.current.pools.standard.searching).toBe(4);
    unmount();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ pools: {}, poll_interval_seconds: 1 });

    const { unmount } = renderHook(() => usePhotoQuickMatchPools(true));
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
