import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Control the Guess the List game fetched by GuessTheListGamePage; the other get* exports just
// need to exist so App's module-level import resolves.
const getGuessTheListGameMock = vi.fn();
vi.mock("../api", () => ({
  getGuessTheListGame: (...args) => getGuessTheListGameMock(...args),
  getGame: vi.fn(),
  createGame: vi.fn(),
  getCareerGame: vi.fn(),
  getPhotoGame: vi.fn(),
}));

// The boards are stubbed so we can read back exactly what onlineInfo App resolved
// and handed down. `../onlineRecovery` is deliberately NOT mocked so the real
// recoverGuessTheListOnlineInfo + the App call-site (no raw loadOnlineInfo fallback) run.
vi.mock("../GuessTheListBoard", () => ({
  default: ({ onlineInfo }) => (
    <div
      data-testid="guess-the-list-board"
      data-online={onlineInfo ? "online" : "null"}
      data-player={onlineInfo?.playerNumber ?? ""}
    />
  ),
}));
vi.mock("../GuessTheListRaceBoard", () => ({
  default: ({ onlineInfo }) => (
    <div
      data-testid="guess-the-list-race-board"
      data-online={onlineInfo ? "online" : "null"}
      data-player={onlineInfo?.playerNumber ?? ""}
    />
  ),
}));
// Stub the remaining setups/boards to keep the test focused on GuessTheListGamePage.
vi.mock("../GameSetup", () => ({ default: () => <div data-testid="game-setup" /> }));
vi.mock("../GameBoard", () => ({ default: () => <div data-testid="game-board" /> }));
vi.mock("../GuessTheListSetup", () => ({ default: () => <div data-testid="guess-the-list-setup" /> }));
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

describe("GuessTheListGamePage stale online-seat recovery (issue #150)", () => {
  it("passes onlineInfo=null to a solo Guess the List board even with a stale elq_game seat", async () => {
    // Stale seat from an earlier online game whose numeric id (7) was later reused.
    saveOnlineInfo(7, { playerNumber: 2, isOnline: true });
    getGuessTheListGameMock.mockResolvedValue({ id: 7, mode: "single_player", is_race: false });

    render(
      <MemoryRouter initialEntries={["/roster/7"]}>
        <App />
      </MemoryRouter>
    );

    const board = await screen.findByTestId("guess-the-list-board");
    expect(board).toHaveAttribute("data-online", "null");
  });

  it("still recovers onlineInfo for an online_friend Guess the List game", async () => {
    saveOnlineInfo(7, { playerNumber: 2, isOnline: true });
    getGuessTheListGameMock.mockResolvedValue({ id: 7, mode: "online_friend", is_race: false });

    render(
      <MemoryRouter initialEntries={["/roster/7"]}>
        <App />
      </MemoryRouter>
    );

    const board = await screen.findByTestId("guess-the-list-board");
    expect(board).toHaveAttribute("data-online", "online");
    expect(board).toHaveAttribute("data-player", "2");
  });
});
