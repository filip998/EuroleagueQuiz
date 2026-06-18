import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../api", () => ({
  getRosterGame: vi.fn(),
  submitRosterGuess: vi.fn(),
  offerEndRound: vi.fn(),
  respondEndRound: vi.fn(),
  connectRosterGuessRealtime: vi.fn(),
  autocompleteRosterPlayer: vi.fn(),
  giveUpRosterRound: vi.fn(),
}));

const realtimeHolder = vi.hoisted(() => ({ opts: null }));
vi.mock("../useOnlineGameRealtime", () => ({
  useOnlineGameRealtime: (opts) => {
    realtimeHolder.opts = opts;
    return { sendAction: vi.fn() };
  },
}));

vi.mock("../ClubLogo", () => ({
  default: ({ code }) => <span data-testid="club-logo">{code}</span>,
}));

import RosterGuessBoard from "../RosterGuessBoard";

beforeEach(() => {
  vi.clearAllMocks();
  realtimeHolder.opts = null;
});

function activeSoloGame(overrides = {}) {
  return {
    id: 1,
    mode: "single_player",
    status: "active",
    player1_name: "Solo",
    player1_score: 0,
    player2_score: 0,
    current_player: 1,
    round_number: 1,
    target_wins: 3,
    turn_seconds: null,
    round: {
      status: "in_progress",
      team_code: "MAD",
      team_name: "Real Madrid",
      season_year: 2020,
      guessed_count: 0,
      total_slots: 1,
      slots: [{ id: 1, position: "Guard", guessed_by_player: null }],
    },
    ...overrides,
  };
}

describe("RosterGuessBoard header navigation", () => {
  it("exposes a single consistent Home control that returns to the app home", () => {
    const onHome = vi.fn();
    const onNewGame = vi.fn();

    render(
      <RosterGuessBoard
        initialState={activeSoloGame()}
        onNewGame={onNewGame}
        onHome={onHome}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));

    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onNewGame).not.toHaveBeenCalled();
  });
});

describe("RosterGuessBoard solo / local never goes online from a stale seat (issue #150)", () => {
  // A stale `elq_game_<id>` seat (from an earlier online game whose numeric id was
  // later reused by a brand-new solo/local game) can hand the board a truthy
  // `onlineInfo`. Mode must win: a non-online game stays offline.
  const staleSeat = { isOnline: true, playerNumber: 1 };

  it("hides the online seat banner for a single_player game with a stale seat", () => {
    render(
      <RosterGuessBoard
        initialState={activeSoloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={staleSeat}
      />
    );

    // The online-only "You are <name>" banner stays hidden; solo keeps Give Up.
    expect(screen.queryByText(/You are/)).not.toBeInTheDocument();
    expect(screen.getByText("Give Up")).toBeInTheDocument();
    // The leak is behavioural too: the realtime transport must stay disabled.
    expect(realtimeHolder.opts.enabled).toBe(false);
  });

  it("stays offline for a local_two_player game with a stale seat", () => {
    render(
      <RosterGuessBoard
        initialState={activeSoloGame({ mode: "local_two_player", player2_name: "Two" })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={staleSeat}
      />
    );

    expect(screen.queryByText(/You are/)).not.toBeInTheDocument();
    expect(realtimeHolder.opts.enabled).toBe(false);
  });
});
