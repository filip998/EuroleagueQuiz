import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

import GameSetup from "../GameSetup";
import HigherLowerSetup from "../HigherLowerSetup";
import CareerQuizSetup from "../CareerQuizSetup";
import PhotoQuizSetup from "../PhotoQuizSetup";
import GuessTheListSetup from "../GuessTheListSetup";

// Mock every network + matchmaking-pool dependency so the five setup screens
// mount without touching the network. Crucially we do NOT mock ../identity or
// ../identityBridge: this test asserts the REAL prefill (getDisplayName) flows
// into the shared NameField on every screen.
vi.mock("../api", () => ({
  // TicTacToe
  createGame: vi.fn(),
  joinGame: vi.fn(),
  quickMatchTicTacToe: vi.fn(),
  // Higher or Lower
  createHigherLowerGame: vi.fn(),
  getHigherLowerLeaderboard: vi.fn(() => Promise.resolve({ entries: [] })),
  // Career Quiz
  careerQuickMatch: vi.fn(),
  createCareerGame: vi.fn(),
  createCareerSoloRound: vi.fn(),
  joinCareerGame: vi.fn(),
  // Photo Quiz
  createPhotoGame: vi.fn(),
  createPhotoSoloRound: vi.fn(),
  joinPhotoGame: vi.fn(),
  photoQuickMatch: vi.fn(),
  // Guess the List
  createGuessTheListGame: vi.fn(),
  createGuessTheListRaceGame: vi.fn(),
  joinGuessTheListGame: vi.fn(),
  joinGuessTheListRaceGame: vi.fn(),
  quickMatchGuessTheListRace: vi.fn(),
}));

const emptyPools = () => ({ pools: {}, error: false });

vi.mock("../quickMatch", async () => ({
  ...(await vi.importActual("../quickMatch")),
  useQuickMatchPools: () => emptyPools(),
}));
vi.mock("../careerQuickMatch", async () => ({
  ...(await vi.importActual("../careerQuickMatch")),
  useCareerQuickMatchPools: () => emptyPools(),
}));
vi.mock("../photoQuickMatch", async () => ({
  ...(await vi.importActual("../photoQuickMatch")),
  usePhotoQuickMatchPools: () => emptyPools(),
}));
vi.mock("../guessTheListRaceQuickMatch", async () => ({
  ...(await vi.importActual("../guessTheListRaceQuickMatch")),
  useGuessTheListRaceQuickMatchPools: () => emptyPools(),
}));

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => <button onClick={onClick}>Home</button>,
  LogoFull: () => <div />,
  default: () => <div />,
}));

const originalLocalStorage = globalThis.localStorage;
const noop = () => {};

// Each setup is rendered in the mode where its single player-name field is on
// screen: every Online create/quick flow, plus Higher or Lower which is always
// a single-field setup.
const SETUPS = [
  {
    name: "TicTacToe",
    render: () => <GameSetup onGameCreated={noop} onBack={noop} />,
  },
  {
    name: "Higher or Lower",
    render: () => <HigherLowerSetup onGameCreated={noop} onBack={noop} />,
  },
  {
    name: "Career Quiz",
    render: () => (
      <CareerQuizSetup
        onSoloRound={noop}
        onGameCreated={noop}
        onGameJoined={noop}
        onBack={noop}
        initialMode="online"
      />
    ),
  },
  {
    name: "Photo Quiz",
    render: () => (
      <PhotoQuizSetup
        onSoloRound={noop}
        onGameCreated={noop}
        onGameJoined={noop}
        onBack={noop}
        initialMode="online"
      />
    ),
  },
  {
    name: "Guess the List",
    render: () => (
      <GuessTheListSetup onGameCreated={noop} onBack={noop} initialMode="online" />
    ),
  },
];

describe("Player name input is consistent across game setups", () => {
  beforeEach(() => {
    const store = new Map([["elq_nickname", "Tester"]]);
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

  it.each(SETUPS)(
    "$name standardizes the player-name field (label, placeholder, optional, length, prefill)",
    async ({ render: renderSetup }) => {
      render(renderSetup());

      const field = screen.getByLabelText("Your Name");

      // One label.
      expect(field.tagName).toBe("INPUT");
      // One placeholder.
      expect(field).toHaveAttribute("placeholder", "Your name");
      // One length cap.
      expect(field).toHaveAttribute("maxlength", "30");
      // One required/optional rule: always optional (anonymous play preserved).
      expect(field).not.toBeRequired();
      // One prefill rule: getDisplayName() (saved nickname here).
      expect(field.value).toBe("Tester");

      // Flush any post-mount async state (e.g. the Higher or Lower leaderboard
      // fetch) so it settles inside act().
      await act(async () => {});
    }
  );
});
