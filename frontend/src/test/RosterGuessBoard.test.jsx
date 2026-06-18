import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const realtimeHolder = vi.hoisted(() => ({ opts: null, sendAction: vi.fn() }));

vi.mock("../useOnlineGameRealtime", () => ({
  useOnlineGameRealtime: (opts) => {
    realtimeHolder.opts = opts;
    return {
      sendAction: realtimeHolder.sendAction,
    };
  },
}));

vi.mock("../api", () => ({
  autocompleteRosterPlayer: vi.fn(),
  cancelRosterRaceQuickMatch: vi.fn(),
  connectRosterGuessRealtime: vi.fn(),
  getRosterGame: vi.fn(),
  submitRosterGuess: vi.fn(),
  offerEndRound: vi.fn(),
  respondEndRound: vi.fn(),
  giveUpRosterRound: vi.fn(),
}));

vi.mock("../onlineRecovery", () => ({ clearOnlineInfo: vi.fn() }));
vi.mock("../quickMatchSeats", () => ({ forgetQuickMatchSeat: vi.fn() }));

vi.mock("../QuickMatchSearchingLobby", () => ({
  default: ({ preset, cancelling, onCancel }) => (
    <div
      data-testid="searching-lobby"
      data-preset={preset}
      data-cancelling={String(cancelling)}
    >
      <button type="button" onClick={onCancel}>
        stub-cancel
      </button>
    </div>
  ),
}));

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => (
    <button data-testid="logo-mini" onClick={onClick}>Logo</button>
  ),
  LogoFull: () => <div data-testid="logo-full" />,
  default: () => <div data-testid="logo-full" />,
}));

import RosterGuessBoard from "../RosterGuessBoard";
import {
  autocompleteRosterPlayer,
  cancelRosterRaceQuickMatch,
} from "../api";
import { clearOnlineInfo } from "../onlineRecovery";
import { forgetQuickMatchSeat } from "../quickMatchSeats";

function raceRound(overrides = {}) {
  return {
    id: 100,
    status: "active",
    team_name: "Olympiacos",
    team_code: "OLY",
    season_year: 2024,
    guessed_count: 0,
    total_slots: 1,
    player1_correct: 0,
    player2_correct: 0,
    slots: [
      {
        id: 1,
        player_id: 55,
        player_name: null,
        guessed_by_player: null,
        jersey_number: "5",
        position: "Guard",
        nationality: "USA",
        country_code: "us",
        height_cm: 188,
        image_url: null,
      },
    ],
    ...overrides,
  };
}

function raceGame(overrides = {}) {
  return {
    id: 7,
    mode: "online_friend",
    game_type: "race",
    status: "active",
    is_public: false,
    preset: null,
    join_code: "ABC123",
    player1_name: "Alice",
    player2_name: "Bob",
    player1_score: 0,
    player2_score: 0,
    winner_player: null,
    current_player: 2,
    round_number: 4,
    target_wins: 3,
    round_seconds: 120,
    reveal_seconds: 12,
    turn_seconds: null,
    latest_completed_round: null,
    round: raceRound(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  realtimeHolder.opts = null;
  realtimeHolder.sendAction.mockReturnValue(true);
});

describe("RosterGuessBoard Race Quick Match", () => {
  it("shows the Quick Match searching lobby for a public Race preset waiting game", () => {
    render(
      <RosterGuessBoard
        initialState={raceGame({
          status: "waiting_for_opponent",
          is_public: true,
          preset: "modern-standard",
        })}
        onlineInfo={{ playerNumber: 1, isOnline: true }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByTestId("searching-lobby")).toHaveAttribute(
      "data-preset",
      "modern-standard"
    );
    expect(screen.queryByText("ABC123")).not.toBeInTheDocument();
  });

  it("keeps the join-code lobby for private Race friend games", () => {
    render(
      <RosterGuessBoard
        initialState={raceGame({ status: "waiting_for_opponent" })}
        onlineInfo={{ playerNumber: 1, isOnline: true }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByTestId("searching-lobby")).not.toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
  });

  it("cancels a Race Quick Match search and clears namespaced recovery data", async () => {
    cancelRosterRaceQuickMatch.mockResolvedValue({ state: { id: 7, status: "cancelled" } });
    const onNewGame = vi.fn();
    render(
      <RosterGuessBoard
        initialState={raceGame({
          status: "waiting_for_opponent",
          is_public: true,
          preset: "modern-standard",
        })}
        onlineInfo={{ playerNumber: 1, isOnline: true }}
        onHome={vi.fn()}
        onNewGame={onNewGame}
      />
    );

    fireEvent.click(screen.getByText("stub-cancel"));

    await waitFor(() =>
      expect(cancelRosterRaceQuickMatch).toHaveBeenCalledWith({
        preset: "modern-standard",
        game_id: 7,
      })
    );
    expect(clearOnlineInfo).toHaveBeenCalledWith(7);
    expect(forgetQuickMatchSeat).toHaveBeenCalledWith("roster:7");
    expect(onNewGame).toHaveBeenCalled();
  });

  it("sends Race guesses with round_number and without current-turn gating", async () => {
    autocompleteRosterPlayer.mockResolvedValue({
      players: [{ player_id: 55, full_name: "Mike James" }],
    });
    render(
      <RosterGuessBoard
        initialState={raceGame({ current_player: 2 })}
        onlineInfo={{ playerNumber: 1, isOnline: true }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const search = screen.getByPlaceholderText("Type a player name to guess...");
    fireEvent.focus(search);
    fireEvent.change(search, {
      target: { value: "Mike" },
    });
    await waitFor(() => expect(screen.getByText("Mike James")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Mike James"));

    expect(realtimeHolder.sendAction).toHaveBeenCalledWith("guess", {
      player_id: 55,
      round_number: 4,
    });
  });

  it("reveals the completed Race round when the server timer expires", async () => {
    render(
      <RosterGuessBoard
        initialState={raceGame()}
        onlineInfo={{ playerNumber: 1, isOnline: true }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const completedRound = raceRound({
      status: "completed",
      player1_correct: 1,
      player2_correct: 0,
      winner_player: 1,
      slots: [
        {
          id: 1,
          player_id: 55,
          player_name: "Mike James",
          guessed_by_player: 1,
          jersey_number: "5",
          position: "Guard",
          nationality: "USA",
          country_code: "us",
          height_cm: 188,
          image_url: null,
        },
      ],
      next_round_starts_at: new Date(Date.now() + 12000).toISOString(),
    });

    await act(async () => {
      realtimeHolder.opts.onState({
        state: raceGame({
          round_number: 5,
          round: raceRound({ id: 101, round_number: 5 }),
          latest_completed_round: completedRound,
        }),
        result: "time_expired",
        completedRound: null,
      });
    });

    expect(screen.getByText("Mike James")).toBeInTheDocument();
    expect(screen.getByText(/Next in/)).toBeInTheDocument();
  });
});
