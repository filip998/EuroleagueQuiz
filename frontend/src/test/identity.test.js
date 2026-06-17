import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getGuestId, getNickname, setNickname, NICKNAME_MAX_LENGTH } from "../identity";

// The Node 25 test runtime ships an inert experimental `localStorage` global
// that shadows jsdom's, so install a working in-memory Storage for these tests.
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

describe("guest id", () => {
  it("generates an id once and persists it", () => {
    const first = getGuestId();
    expect(first).toBeTruthy();
    expect(localStorage.getItem("elq_guest_id")).toBe(first);

    const second = getGuestId();
    expect(second).toBe(first);
  });

  it("returns the stored id without regenerating", () => {
    localStorage.setItem("elq_guest_id", "existing-id");
    expect(getGuestId()).toBe("existing-id");
  });

  it("regenerates when the stored id is blank", () => {
    localStorage.setItem("elq_guest_id", "");
    const id = getGuestId();
    expect(id).not.toBe("");
    expect(localStorage.getItem("elq_guest_id")).toBe(id);
  });

  it("regenerates when the stored id is too long", () => {
    const corrupted = "x".repeat(65);
    localStorage.setItem("elq_guest_id", corrupted);
    const id = getGuestId();
    expect(id).not.toBe(corrupted);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("regenerates when the stored id is only whitespace", () => {
    localStorage.setItem("elq_guest_id", "   ");
    const id = getGuestId();
    expect(id.trim().length).toBeGreaterThan(0);
    expect(localStorage.getItem("elq_guest_id")).toBe(id);
  });
});

describe("nickname", () => {
  it("returns an empty string when unset", () => {
    expect(getNickname()).toBe("");
  });

  it("persists a trimmed nickname", () => {
    const saved = setNickname("  Dragan  ");
    expect(saved).toBe("Dragan");
    expect(getNickname()).toBe("Dragan");
    expect(localStorage.getItem("elq_nickname")).toBe("Dragan");
  });

  it("clamps the nickname to the max length", () => {
    const long = "a".repeat(NICKNAME_MAX_LENGTH + 10);
    const saved = setNickname(long);
    expect(saved.length).toBe(NICKNAME_MAX_LENGTH);
    expect(getNickname().length).toBe(NICKNAME_MAX_LENGTH);
  });

  it("removes the nickname when set to blank", () => {
    setNickname("Marko");
    setNickname("   ");
    expect(getNickname()).toBe("");
    expect(localStorage.getItem("elq_nickname")).toBeNull();
  });

  it("migrates the legacy Higher or Lower nickname once", () => {
    localStorage.setItem("hol_nickname", "LegacyName");
    expect(getNickname()).toBe("LegacyName");
    expect(localStorage.getItem("elq_nickname")).toBe("LegacyName");
    // The legacy key is dropped so it can't resurrect later.
    expect(localStorage.getItem("hol_nickname")).toBeNull();
  });

  it("does not resurrect the legacy nickname after it is cleared", () => {
    localStorage.setItem("hol_nickname", "LegacyName");
    expect(getNickname()).toBe("LegacyName");
    setNickname("   ");
    expect(getNickname()).toBe("");
    expect(localStorage.getItem("elq_nickname")).toBeNull();
  });

  it("prefers the shared nickname over the legacy key", () => {
    localStorage.setItem("hol_nickname", "LegacyName");
    setNickname("CurrentName");
    expect(getNickname()).toBe("CurrentName");
  });
});
