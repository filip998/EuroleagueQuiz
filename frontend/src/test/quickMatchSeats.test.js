import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  recallQuickMatchSeat,
  rememberQuickMatchSeat,
  resolveQuickMatchSeat,
} from "../quickMatchSeats";

// The Node test runtime ships an inert experimental `localStorage` global that
// shadows jsdom's, so install a working in-memory Storage for these tests.
const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
});

afterEach(() => {
  globalThis.localStorage = originalLocalStorage;
});

describe("quick match seats", () => {
  it("returns null for an unknown game", () => {
    expect(recallQuickMatchSeat(123)).toBeNull();
  });

  it("infers player 1 for a waiting game and player 2 for an active game", () => {
    expect(resolveQuickMatchSeat(1, "waiting_for_opponent")).toBe(1);
    expect(resolveQuickMatchSeat(2, "active")).toBe(2);
  });

  it("records the resolved seat so it can be recalled later", () => {
    resolveQuickMatchSeat(7, "waiting_for_opponent");
    expect(recallQuickMatchSeat(7)).toBe(1);
  });

  it("is first-write-wins: a recorded seat is never overwritten", () => {
    // We created the game as player 1 (waiting), so the seat is recorded as 1.
    expect(resolveQuickMatchSeat(7, "waiting_for_opponent")).toBe(1);
    // Re-entering once the game is active must still resolve to player 1, not 2.
    expect(resolveQuickMatchSeat(7, "active")).toBe(1);
    expect(recallQuickMatchSeat(7)).toBe(1);
  });

  it("recalls a seat recorded in another tab via shared storage", () => {
    rememberQuickMatchSeat(42, 2);
    // A fresh resolve in the same browser (e.g. another tab) prefers the
    // recorded seat over status inference.
    expect(resolveQuickMatchSeat(42, "waiting_for_opponent")).toBe(2);
  });

  it("ignores invalid seat values", () => {
    expect(rememberQuickMatchSeat(5, 3)).toBeNull();
    expect(recallQuickMatchSeat(5)).toBeNull();
  });

  it("degrades to inference when storage is unavailable", () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
      clear: () => {},
    };
    expect(resolveQuickMatchSeat(9, "active")).toBe(2);
    expect(resolveQuickMatchSeat(9, "waiting_for_opponent")).toBe(1);
  });
});
