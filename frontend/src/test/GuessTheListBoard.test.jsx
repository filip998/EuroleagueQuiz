import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../api", () => ({
  getGuessTheListGame: vi.fn(),
  submitGuessTheList: vi.fn(),
  offerEndRound: vi.fn(),
  respondEndRound: vi.fn(),
  connectGuessTheListRealtime: vi.fn(),
  autocompleteGuessTheListPlayer: vi.fn(),
  giveUpGuessTheListRound: vi.fn(),
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

import GuessTheListBoard from "../GuessTheListBoard";

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

describe("GuessTheListBoard header navigation", () => {
  it("exposes a single consistent Home control that returns to the app home", () => {
    const onHome = vi.fn();
    const onNewGame = vi.fn();

    render(
      <GuessTheListBoard
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

describe("GuessTheListBoard end-of-game result", () => {
  it("does not credit Player 2 when a finished online game has no winner", () => {
    render(
      <GuessTheListBoard
        initialState={{
          id: 2,
          mode: "online_friend",
          status: "finished",
          player1_name: "Alice",
          player2_name: "Bob",
          player1_score: 1,
          player2_score: 1,
          current_player: 1,
          round_number: 2,
          target_wins: 2,
          turn_seconds: null,
          winner_player: null,
          round: {
            status: "completed",
            team_code: "MAD",
            team_name: "Real Madrid",
            season_year: 2020,
            guessed_count: 1,
            total_slots: 1,
            slots: [{ id: 1, position: "Guard", guessed_by_player: 1 }],
          },
        }}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    // A null winner must not fall through to the Player 2 name; the shared
    // winnerDisplayName helper renders a neutral "No winner" headline.
    expect(screen.getByRole("heading", { name: "No winner" })).toBeInTheDocument();
    expect(screen.queryByText("Bob WINS!")).not.toBeInTheDocument();
  });
});

describe("GuessTheListBoard solo / local never goes online from a stale seat (issue #150)", () => {
  // A stale `elq_game_<id>` seat (from an earlier online game whose numeric id was
  // later reused by a brand-new solo/local game) can hand the board a truthy
  // `onlineInfo`. Mode must win: a non-online game stays offline.
  const staleSeat = { isOnline: true, playerNumber: 1 };

  it("hides the online seat banner for a single_player game with a stale seat", () => {
    render(
      <GuessTheListBoard
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
      <GuessTheListBoard
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

describe("GuessTheListBoard leaderboard rounds", () => {
  function allTimeSoloGame(overrides = {}) {
    return activeSoloGame({
      round: {
        status: "in_progress",
        category_type: "all_time",
        scope_label: "All-time points leaders (2000-2025)",
        team_code: null,
        team_name: null,
        season_year: null,
        guessed_count: 1,
        total_slots: 2,
        slots: [
          {
            id: 1,
            position: "Guard",
            nationality: "Spain",
            guessed_by_player: 1,
            player_name: "Sergio Llull",
            rank: 1,
            stat_value: 4812,
            stat_value_label: "4,812 pts",
          },
          {
            id: 2,
            position: null,
            nationality: null,
            guessed_by_player: null,
            player_name: null,
            // The backend nulls rank/stat until reveal; we send non-null values
            // here to prove the frontend itself still masks them for an
            // unclaimed slot (defense-in-depth, not trusting backend nulls).
            rank: 2,
            stat_value: 3500,
            stat_value_label: "3,500 pts",
          },
        ],
      },
      ...overrides,
    });
  }

  it("renders the scope label header and a claimed slot's rank and stat value", () => {
    render(
      <GuessTheListBoard initialState={allTimeSoloGame()} onNewGame={() => {}} onHome={() => {}} />
    );

    expect(screen.getByText("All-time points leaders (2000-2025)")).toBeInTheDocument();
    expect(screen.getByText("Sergio Llull")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("4,812 pts")).toBeInTheDocument();
    // Leaderboard rounds drop the team logo + season chrome.
    expect(screen.queryByTestId("club-logo")).not.toBeInTheDocument();
  });

  it("hides rank and stat value for an unclaimed leaderboard slot", () => {
    render(
      <GuessTheListBoard initialState={allTimeSoloGame()} onNewGame={() => {}} onHome={() => {}} />
    );

    // The hidden slot stays masked: no rank badge, no stat value leaked.
    expect(screen.getByText("???")).toBeInTheDocument();
    expect(screen.queryByText("#2")).not.toBeInTheDocument();
    expect(screen.queryByText("3,500 pts")).not.toBeInTheDocument();
  });
});
