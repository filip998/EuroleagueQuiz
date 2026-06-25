import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadSetupPreferences,
  saveSetupPreferences,
} from "../setupPreferences";

// The Node 25 test runtime ships an inert experimental `localStorage` global
// that shadows jsdom's, so install a working in-memory Storage for these tests.
const originalLocalStorage = globalThis.localStorage;

function key(game) {
  return `elq_setup_prefs_v1_${game}`;
}

beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, value) => store.set(k, String(value)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
});

afterEach(() => {
  globalThis.localStorage = originalLocalStorage;
});

describe("loadSetupPreferences", () => {
  it("returns {} for an unknown game key", () => {
    expect(loadSetupPreferences("nope")).toEqual({});
  });

  it("returns {} when nothing is stored", () => {
    expect(loadSetupPreferences("higherlower")).toEqual({});
  });

  it("returns {} when the stored value is not valid JSON", () => {
    localStorage.setItem(key("higherlower"), "{not json");
    expect(loadSetupPreferences("higherlower")).toEqual({});
  });

  it("returns {} when the stored value is an array", () => {
    localStorage.setItem(key("higherlower"), JSON.stringify([1, 2, 3]));
    expect(loadSetupPreferences("higherlower")).toEqual({});
  });

  it("returns {} when the stored value is null", () => {
    localStorage.setItem(key("higherlower"), JSON.stringify(null));
    expect(loadSetupPreferences("higherlower")).toEqual({});
  });

  it("degrades to {} when storage access throws", () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadSetupPreferences("higherlower")).toEqual({});
  });
});

describe("round-trips per game", () => {
  it("higherlower tier + season range", () => {
    saveSetupPreferences("higherlower", {
      tier: "hard",
      seasonStart: 2010,
      seasonEnd: 2020,
    });
    expect(loadSetupPreferences("higherlower")).toEqual({
      tier: "hard",
      seasonStart: 2010,
      seasonEnd: 2020,
    });
  });

  it("tictactoe choices including quick preset", () => {
    saveSetupPreferences("tictactoe", {
      mode: "online",
      onlineSub: "friend",
      friendSub: "create",
      targetWins: 5,
      timerMode: "15s",
      quickPreset: "blitz",
    });
    expect(loadSetupPreferences("tictactoe")).toEqual({
      mode: "online",
      onlineSub: "friend",
      friendSub: "create",
      targetWins: 5,
      timerMode: "15s",
      quickPreset: "blitz",
    });
  });

  it("career choices", () => {
    saveSetupPreferences("career", {
      mode: "online",
      onlineSub: "quick",
      friendSub: "join",
      targetWins: 7,
      wrongGuessVisibility: "shared",
      quickPreset: "long",
    });
    expect(loadSetupPreferences("career")).toEqual({
      mode: "online",
      onlineSub: "quick",
      friendSub: "join",
      targetWins: 7,
      wrongGuessVisibility: "shared",
      quickPreset: "long",
    });
  });

  it("photo choices use a separate key from career", () => {
    saveSetupPreferences("career", { mode: "solo" });
    saveSetupPreferences("photo", { mode: "online", targetWins: 3 });
    expect(loadSetupPreferences("career")).toEqual({ mode: "solo" });
    expect(loadSetupPreferences("photo")).toEqual({
      mode: "online",
      targetWins: 3,
    });
  });

  it("guessTheList choices including category + race", () => {
    saveSetupPreferences("guessTheList", {
      mode: "online",
      onlineGameType: "race",
      classicSub: "create",
      raceSub: "friend",
      friendSub: "join",
      targetWins: 5,
      raceTargetWins: 3,
      timerMode: "unlimited",
      categoryType: "all_euroleague",
      seasonStart: 2005,
      seasonEnd: 2015,
      quickPreset: "quick",
    });
    expect(loadSetupPreferences("guessTheList")).toEqual({
      mode: "online",
      onlineGameType: "race",
      classicSub: "create",
      raceSub: "friend",
      friendSub: "join",
      targetWins: 5,
      raceTargetWins: 3,
      timerMode: "unlimited",
      categoryType: "all_euroleague",
      seasonStart: 2005,
      seasonEnd: 2015,
      quickPreset: "quick",
    });
  });
});

describe("validation + sanitization", () => {
  it("drops unknown fields", () => {
    saveSetupPreferences("higherlower", {
      tier: "hard",
      bogus: "value",
      anotherUnknown: 42,
    });
    expect(loadSetupPreferences("higherlower")).toEqual({ tier: "hard" });
  });

  it("never persists sensitive identifiers passed by a caller", () => {
    saveSetupPreferences("tictactoe", {
      mode: "online",
      joinCode: "ABC123",
      gameId: 99,
      guest_id: "guest-token",
      player1_name: "Filip",
      authToken: "secret",
    });
    const stored = JSON.parse(localStorage.getItem(key("tictactoe")));
    expect(stored).toEqual({ mode: "online" });
    expect(loadSetupPreferences("tictactoe")).toEqual({ mode: "online" });
  });

  it("drops invalid enum values but keeps valid ones", () => {
    saveSetupPreferences("higherlower", { tier: "impossible" });
    expect(loadSetupPreferences("higherlower")).toEqual({});

    saveSetupPreferences("tictactoe", { mode: "online", targetWins: 4 });
    expect(loadSetupPreferences("tictactoe")).toEqual({ mode: "online" });
  });

  it("drops out-of-range seasons", () => {
    saveSetupPreferences("higherlower", {
      tier: "medium",
      seasonStart: 1999,
      seasonEnd: 2099,
    });
    expect(loadSetupPreferences("higherlower")).toEqual({ tier: "medium" });
  });

  it("drops the whole season range when start > end (save side)", () => {
    saveSetupPreferences("higherlower", {
      tier: "easy",
      seasonStart: 2020,
      seasonEnd: 2010,
    });
    expect(loadSetupPreferences("higherlower")).toEqual({ tier: "easy" });
  });

  it("drops an inconsistent season range stored directly (load side)", () => {
    localStorage.setItem(
      key("guessTheList"),
      JSON.stringify({
        categoryType: "roster",
        seasonStart: 2018,
        seasonEnd: 2002,
      }),
    );
    expect(loadSetupPreferences("guessTheList")).toEqual({
      categoryType: "roster",
    });
  });

  it("keeps a single valid season endpoint when only one is present", () => {
    saveSetupPreferences("higherlower", { seasonStart: 2012 });
    expect(loadSetupPreferences("higherlower")).toEqual({ seasonStart: 2012 });
  });
});

describe("saveSetupPreferences guards", () => {
  it("ignores unknown game keys", () => {
    saveSetupPreferences("nope", { foo: "bar" });
    expect(localStorage.getItem(key("nope"))).toBeNull();
  });

  it("ignores non-object payloads", () => {
    saveSetupPreferences("higherlower", null);
    saveSetupPreferences("higherlower", "string");
    saveSetupPreferences("higherlower", [1, 2]);
    expect(loadSetupPreferences("higherlower")).toEqual({});
  });

  it("does not throw when storage write fails", () => {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() =>
      saveSetupPreferences("higherlower", { tier: "hard" }),
    ).not.toThrow();
  });
});
