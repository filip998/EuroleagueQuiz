import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recallQuickMatchSeat,
  rememberQuickMatchSeat,
  resolveQuickMatchSeat,
  forgetQuickMatchSeat,
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

  it("forgets a recorded seat so a reused id is not mis-seated", () => {
    rememberQuickMatchSeat(7, 1);
    expect(recallQuickMatchSeat(7)).toBe(1);

    forgetQuickMatchSeat(7);
    expect(recallQuickMatchSeat(7)).toBeNull();

    // A later game that reuses id 7 (e.g. as player 2) now records cleanly
    // instead of inheriting the stale first-write-wins seat.
    expect(resolveQuickMatchSeat(7, "active")).toBe(2);
  });

  it("forgetting an unknown or null game is a no-op and preserves others", () => {
    rememberQuickMatchSeat(7, 1);
    forgetQuickMatchSeat(999);
    forgetQuickMatchSeat(null);
    expect(recallQuickMatchSeat(7)).toBe(1);
  });

  it("swallows storage errors when forgetting a seat", () => {
    rememberQuickMatchSeat(7, 1);
    globalThis.localStorage.setItem = () => {
      throw new Error("blocked");
    };
    expect(() => forgetQuickMatchSeat(7)).not.toThrow();
  });
});

// These exercise the in-memory fallback used when localStorage cannot retain the
// seat map. Each test uses a fresh module instance (vi.resetModules) so the
// module-level shadow can't leak across tests.
describe("quick match seats without persistent storage", () => {
  const originalLocalStorage = globalThis.localStorage;

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
  });

  async function freshSeats() {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {},
      clear: () => {},
    };
    vi.resetModules();
    return import("../quickMatchSeats");
  }

  it("infers the seat on first contact", async () => {
    const { resolveQuickMatchSeat: resolve } = await freshSeats();
    // First time each id is seen, with no recorded seat: pure status inference.
    expect(resolve(9, "active")).toBe(2);
    expect(resolve(10, "waiting_for_opponent")).toBe(1);
  });

  it("keeps the first seat across re-entry so the creator stays player 1", async () => {
    const { resolveQuickMatchSeat: resolve, recallQuickMatchSeat: recall } =
      await freshSeats();
    // Created the game as player 1 while it was waiting.
    expect(resolve(9, "waiting_for_opponent")).toBe(1);
    // Re-entering once the backend returns it as ACTIVE must still resolve to
    // player 1 — without the in-memory shadow this would mis-infer player 2 and
    // seat the creator as their own opponent.
    expect(resolve(9, "active")).toBe(1);
    expect(recall(9)).toBe(1);
  });
});
