import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Recovery's seat-map fallback is the only branch with a real dependency; mock it
// so each test controls exactly what the durable map returns.
const recallMock = vi.fn();
vi.mock("../quickMatchSeats", () => ({
  recallQuickMatchSeat: (gameId) => recallMock(gameId),
}));

import {
  saveOnlineInfo,
  loadOnlineInfo,
  recoverOnlineInfo,
  recoverPhotoOnlineInfo,
  recoverCareerOnlineInfo,
  recoverRosterOnlineInfo,
  clearOnlineInfo,
} from "../onlineRecovery";

// Node's experimental test globals can ship an inert sessionStorage that shadows
// jsdom's, so install a working in-memory Storage for these tests.
const originalSessionStorage = globalThis.sessionStorage;

beforeEach(() => {
  recallMock.mockReset();
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
});

afterEach(() => {
  globalThis.sessionStorage = originalSessionStorage;
});

describe("saveOnlineInfo / loadOnlineInfo", () => {
  it("round-trips the seat through sessionStorage", () => {
    saveOnlineInfo(7, { playerNumber: 2, isOnline: true });
    expect(loadOnlineInfo(7)).toEqual({ playerNumber: 2, isOnline: true });
  });

  it("does nothing when there is no online info", () => {
    saveOnlineInfo(7, null);
    expect(loadOnlineInfo(7)).toBeNull();
  });

  it("swallows storage failures instead of throwing", () => {
    globalThis.sessionStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
      clear: () => {},
    };
    expect(() => saveOnlineInfo(7, { playerNumber: 1, isOnline: true })).not.toThrow();
    expect(loadOnlineInfo(7)).toBeNull();
  });
});

describe("clearOnlineInfo", () => {
  it("removes the stored seat so a reused id is not recovered as online", () => {
    saveOnlineInfo(7, { playerNumber: 1, isOnline: true });
    clearOnlineInfo(7);
    expect(loadOnlineInfo(7)).toBeNull();
    // A later non-online game that reuses id 7 must not recover online info.
    expect(recoverOnlineInfo(7, { mode: "single_player" })).toBeNull();
  });

  it("swallows storage failures instead of throwing", () => {
    globalThis.sessionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("denied");
      },
      clear: () => {},
    };
    expect(() => clearOnlineInfo(7)).not.toThrow();
  });
});

describe("recoverOnlineInfo", () => {
  it("prefers the per-tab sessionStorage seat", () => {
    saveOnlineInfo(7, { playerNumber: 1, isOnline: true });
    const info = recoverOnlineInfo(7, { mode: "online_friend" });
    expect(info).toEqual({ playerNumber: 1, isOnline: true });
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("falls back to the Quick Match seat map for online_friend games", () => {
    recallMock.mockReturnValue(2);
    const info = recoverOnlineInfo(7, { mode: "online_friend" });
    expect(info).toEqual({ playerNumber: 2, isOnline: true });
    expect(recallMock).toHaveBeenCalledWith(7);
  });

  it("does not fall back for non-online_friend games", () => {
    recallMock.mockReturnValue(2);
    expect(recoverOnlineInfo(7, { mode: "single_player" })).toBeNull();
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("returns null when neither source has a seat", () => {
    recallMock.mockReturnValue(null);
    expect(recoverOnlineInfo(7, { mode: "online_friend" })).toBeNull();
  });
});

describe("recoverPhotoOnlineInfo", () => {
  const publicQuickMatch = {
    mode: "online_friend",
    is_public: true,
    preset: "standard",
  };

  it("prefers the per-tab sessionStorage seat", () => {
    saveOnlineInfo(7, { playerNumber: 1, isOnline: true });
    const info = recoverPhotoOnlineInfo(7, publicQuickMatch);
    expect(info).toEqual({ playerNumber: 1, isOnline: true });
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("falls back to the photo-namespaced seat map for public Quick Match games", () => {
    recallMock.mockReturnValue(2);
    const info = recoverPhotoOnlineInfo(7, publicQuickMatch);
    expect(info).toEqual({ playerNumber: 2, isOnline: true });
    expect(recallMock).toHaveBeenCalledWith("photo:7");
  });

  it("does not fall back for private friend games (no preset / not public)", () => {
    recallMock.mockReturnValue(2);
    expect(recoverPhotoOnlineInfo(7, { mode: "online_friend" })).toBeNull();
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("does not fall back for non-online_friend games", () => {
    recallMock.mockReturnValue(2);
    expect(
      recoverPhotoOnlineInfo(7, { mode: "single_player", is_public: true, preset: "standard" })
    ).toBeNull();
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("returns null when neither source has a seat", () => {
    recallMock.mockReturnValue(null);
    expect(recoverPhotoOnlineInfo(7, publicQuickMatch)).toBeNull();
  });
});

describe("recoverCareerOnlineInfo", () => {
  const publicQuickMatch = {
    mode: "online_friend",
    is_public: true,
    preset: "standard",
  };

  it("prefers the per-tab sessionStorage seat", () => {
    saveOnlineInfo(7, { playerNumber: 1, isOnline: true });
    expect(recoverCareerOnlineInfo(7, publicQuickMatch)).toEqual({
      playerNumber: 1,
      isOnline: true,
    });
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("falls back to the career-namespaced seat map for public Quick Match games", () => {
    recallMock.mockReturnValue(2);
    expect(recoverCareerOnlineInfo(7, publicQuickMatch)).toEqual({
      playerNumber: 2,
      isOnline: true,
    });
    expect(recallMock).toHaveBeenCalledWith("career:7");
  });

  it("does not fall back for non-online_friend games", () => {
    recallMock.mockReturnValue(2);
    expect(
      recoverCareerOnlineInfo(7, { mode: "single_player", is_public: true, preset: "standard" })
    ).toBeNull();
    expect(recallMock).not.toHaveBeenCalled();
  });
});

describe("recoverRosterOnlineInfo", () => {
  const publicRaceQuickMatch = {
    mode: "online_friend",
    is_race: true,
    is_public: true,
    preset: "full-standard",
  };

  it("prefers the per-tab sessionStorage seat", () => {
    saveOnlineInfo(7, { playerNumber: 1, isOnline: true });
    expect(recoverRosterOnlineInfo(7, publicRaceQuickMatch)).toEqual({
      playerNumber: 1,
      isOnline: true,
    });
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("falls back to the roster-race-namespaced seat map for public race Quick Match games", () => {
    recallMock.mockReturnValue(2);
    expect(recoverRosterOnlineInfo(7, publicRaceQuickMatch)).toEqual({
      playerNumber: 2,
      isOnline: true,
    });
    expect(recallMock).toHaveBeenCalledWith("roster-race:7");
  });

  it("does not consult the race seat map for a private classic online game", () => {
    recallMock.mockReturnValue(2);
    expect(recoverRosterOnlineInfo(7, { mode: "online_friend" })).toBeNull();
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("does not fall back for non-online_friend games", () => {
    recallMock.mockReturnValue(2);
    expect(
      recoverRosterOnlineInfo(7, {
        mode: "single_player",
        is_race: true,
        is_public: true,
        preset: "full-standard",
      })
    ).toBeNull();
    expect(recallMock).not.toHaveBeenCalled();
  });
});

// Issue #150: a stale `elq_game_<id>` seat (left over from an earlier online game
// whose numeric id was later reused by a brand-new solo/local game after a prod DB
// reseed) must never make a non-online game recover as online — across every
// per-game recovery variant.
describe("solo / local games never recover a stale online seat (issue #150)", () => {
  const variants = [
    ["recoverOnlineInfo", recoverOnlineInfo],
    ["recoverPhotoOnlineInfo", recoverPhotoOnlineInfo],
    ["recoverCareerOnlineInfo", recoverCareerOnlineInfo],
    ["recoverRosterOnlineInfo", recoverRosterOnlineInfo],
  ];
  const nonOnlineModes = ["single_player", "local_two_player"];

  for (const [name, recover] of variants) {
    for (const mode of nonOnlineModes) {
      it(`${name} ignores a stale stored seat for a ${mode} game`, () => {
        saveOnlineInfo(7, { playerNumber: 2, isOnline: true });
        recallMock.mockReturnValue(2);

        expect(
          recover(7, { mode, is_public: true, preset: "standard", is_race: true })
        ).toBeNull();
        // The seat-map fallback must never run for a non-online game...
        expect(recallMock).not.toHaveBeenCalled();
        // ...and the shared, non-namespaced seat key is left intact so a live
        // online game of another type that reuses this id keeps its seat.
        expect(loadOnlineInfo(7)).toEqual({ playerNumber: 2, isOnline: true });
      });
    }
  }
});
