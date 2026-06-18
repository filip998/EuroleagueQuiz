import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Control the roster game fetched by RosterGamePage; the other get* exports just
// need to exist so App's module-level import resolves.
const getRosterGameMock = vi.fn();
vi.mock("../api", () => ({
  getRosterGame: (...args) => getRosterGameMock(...args),
  getGame: vi.fn(),
  getCareerGame: vi.fn(),
  getPhotoGame: vi.fn(),
}));

// The boards are stubbed so we can read back exactly what onlineInfo App resolved
// and handed down. `../onlineRecovery` is deliberately NOT mocked so the real
// recoverRosterOnlineInfo + the App call-site (no raw loadOnlineInfo fallback) run.
vi.mock("../RosterGuessBoard", () => ({
  default: ({ onlineInfo }) => (
    <div data-testid="roster-board" data-online={onlineInfo ? "online" : "null"} />
  ),
}));
vi.mock("../RosterGuessRaceBoard", () => ({
  default: ({ onlineInfo }) => (
    <div data-testid="roster-race-board" data-online={onlineInfo ? "online" : "null"} />
  ),
}));
// Stub the remaining setups/boards to keep the test focused on RosterGamePage.
vi.mock("../GameSetup", () => ({ default: () => <div data-testid="game-setup" /> }));
vi.mock("../GameBoard", () => ({ default: () => <div data-testid="game-board" /> }));
vi.mock("../RosterGuessSetup", () => ({ default: () => <div data-testid="roster-setup" /> }));
vi.mock("../HigherLowerSetup", () => ({ default: () => <div data-testid="hl-setup" /> }));
vi.mock("../HigherLowerBoard", () => ({ default: () => <div data-testid="hl-board" /> }));
vi.mock("../CareerQuizSetup", () => ({ default: () => <div data-testid="career-setup" /> }));
vi.mock("../CareerQuizBoard", () => ({ default: () => <div data-testid="career-board" /> }));
vi.mock("../PhotoQuizSetup", () => ({ default: () => <div data-testid="photo-setup" /> }));
vi.mock("../PhotoQuizBoard", () => ({ default: () => <div data-testid="photo-board" /> }));

import App from "../App";
import { saveOnlineInfo } from "../onlineRecovery";

// Node's experimental test globals can ship an inert sessionStorage; install a
// working in-memory Storage so saveOnlineInfo/loadOnlineInfo behave like a browser.
const originalSessionStorage = globalThis.sessionStorage;

beforeEach(() => {
  vi.clearAllMocks();
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

describe("RosterGamePage stale online-seat recovery (issue #150)", () => {
  it("passes onlineInfo=null to a solo roster board even with a stale elq_game seat", async () => {
    // Stale seat from an earlier online game whose numeric id (7) was later reused.
    saveOnlineInfo(7, { playerNumber: 2, isOnline: true });
    getRosterGameMock.mockResolvedValue({ id: 7, mode: "single_player", is_race: false });

    render(
      <MemoryRouter initialEntries={["/roster/7"]}>
        <App />
      </MemoryRouter>
    );

    const board = await screen.findByTestId("roster-board");
    expect(board).toHaveAttribute("data-online", "null");
  });

  it("still recovers onlineInfo for an online_friend roster game", async () => {
    saveOnlineInfo(7, { playerNumber: 2, isOnline: true });
    getRosterGameMock.mockResolvedValue({ id: 7, mode: "online_friend", is_race: false });

    render(
      <MemoryRouter initialEntries={["/roster/7"]}>
        <App />
      </MemoryRouter>
    );

    const board = await screen.findByTestId("roster-board");
    expect(board).toHaveAttribute("data-online", "online");
  });
});
