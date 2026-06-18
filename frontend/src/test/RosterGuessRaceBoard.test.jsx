import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendActionMock = vi.hoisted(() => vi.fn());
const realtimeHolder = vi.hoisted(() => ({ opts: null }));

vi.mock("../api", () => ({
  autocompleteRosterPlayer: vi.fn(),
  cancelRosterRaceQuickMatch: vi.fn(),
  connectRosterGuessRealtime: vi.fn(),
  getRosterGame: vi.fn(),
  submitRosterGuess: vi.fn(),
  getRosterRaceQuickMatchPools: vi.fn(),
  resignRosterRaceGame: vi.fn(),
}));

vi.mock("../useOnlineGameRealtime", () => ({
  useOnlineGameRealtime: (opts) => {
    realtimeHolder.opts = opts;
    return {
      sendAction: sendActionMock,
    };
  },
}));

vi.mock("../QuickMatchSearchingLobby", () => ({
  default: ({ preset, cancelling, onCancel }) => (
    <div data-testid="searching-lobby" data-preset={preset} data-cancelling={String(cancelling)}>
      <button type="button" onClick={onCancel}>
        Cancel search
      </button>
    </div>
  ),
}));

vi.mock("../onlineRecovery", () => ({
  clearOnlineInfo: vi.fn(),
}));

vi.mock("../quickMatchSeats", () => ({
  forgetQuickMatchSeat: vi.fn(),
}));

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => <button onClick={onClick}>Home</button>,
}));

vi.mock("../ClubLogo", () => ({
  default: ({ code }) => <span data-testid="club-logo">{code}</span>,
}));

import RosterGuessRaceBoard from "../RosterGuessRaceBoard";
import {
  autocompleteRosterPlayer,
  cancelRosterRaceQuickMatch,
  resignRosterRaceGame,
} from "../api";
import { clearOnlineInfo } from "../onlineRecovery";
import { forgetQuickMatchSeat } from "../quickMatchSeats";
import { buildInviteUrl } from "../inviteLink";

describe("RosterGuessRaceBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendActionMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends Race claims over realtime with the visible round number", async () => {
    autocompleteRosterPlayer.mockResolvedValue({
      players: [{ player_id: 99, full_name: "Luka Doncic" }],
    });

    render(
      <RosterGuessRaceBoard
        initialState={activeRaceGame()}
        onlineInfo={{ playerNumber: 1 }}
        onNewGame={vi.fn()}
        onHome={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Type a player name to claim...");
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: "luka" },
    });

    await waitFor(() => expect(screen.getByText("Luka Doncic")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Luka Doncic"));

    expect(sendActionMock).toHaveBeenCalledWith("guess", {
      player_id: 99,
      round_number: 4,
    });
  });

  it("renders the unified online scoreboard with a seat-colored self-indicator", () => {
    render(
      <RosterGuessRaceBoard
        initialState={activeRaceGame()}
        onlineInfo={{ playerNumber: 1 }}
        onNewGame={vi.fn()}
        onHome={vi.fn()}
      />
    );

    const scoreboard = screen.getByLabelText("Roster Race multiplayer scoreboard");
    expect(within(scoreboard).getByText("Ace")).toBeInTheDocument();
    expect(within(scoreboard).getByText("Runner")).toBeInTheDocument();
    expect(within(scoreboard).getByText("Round 4")).toBeInTheDocument();
    expect(within(scoreboard).getByText("First to 2")).toBeInTheDocument();

    const pill = within(scoreboard).getByText("You are Ace").closest("div");
    expect(pill.querySelector(".bg-elq-player1")).toBeTruthy();
  });

  it("highlights Race claims with ArrowDown and submits the highlighted row on Enter", async () => {
    autocompleteRosterPlayer.mockResolvedValue({
      players: [
        { player_id: 98, full_name: "Nikola Mirotic" },
        { player_id: 99, full_name: "Luka Doncic" },
      ],
    });

    render(
      <RosterGuessRaceBoard
        initialState={activeRaceGame()}
        onlineInfo={{ playerNumber: 1 }}
        onNewGame={vi.fn()}
        onHome={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Type a player name to claim...");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });

    const first = await screen.findByText("Nikola Mirotic");
    const second = screen.getByText("Luka Doncic");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(first.closest("button")).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(second.closest("button")).toHaveAttribute("aria-selected", "true");
    expect(first.closest("button")).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(sendActionMock).toHaveBeenCalledWith("guess", {
      player_id: 99,
      round_number: 4,
    });
  });

  it("renders public waiting Race games in the quick-match searching lobby and cancels them", async () => {
    cancelRosterRaceQuickMatch.mockResolvedValue({ state: { id: 30, status: "cancelled" } });
    const onNewGame = vi.fn();

    render(
      <RosterGuessRaceBoard
        initialState={{
          ...activeRaceGame(),
          id: 30,
          status: "waiting_for_opponent",
          is_public: true,
          preset: "modern-standard",
        }}
        onlineInfo={{ playerNumber: 1 }}
        onNewGame={onNewGame}
        onHome={vi.fn()}
      />
    );

    expect(screen.getByTestId("searching-lobby")).toHaveAttribute(
      "data-preset",
      "modern-standard"
    );
    // Public quick-match games hide the join code, so no invite link must leak.
    expect(screen.queryByText("Copy link")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel search"));

    await waitFor(() => expect(onNewGame).toHaveBeenCalled());
    expect(cancelRosterRaceQuickMatch).toHaveBeenCalledWith({
      preset: "modern-standard",
      game_id: 30,
    });
    expect(clearOnlineInfo).toHaveBeenCalledWith(30);
    expect(forgetQuickMatchSeat).toHaveBeenCalledWith("roster-race:30");
  });

  it("shows a shareable invite link in the private friend waiting lobby", () => {
    render(
      <RosterGuessRaceBoard
        initialState={{
          ...activeRaceGame(),
          status: "waiting_for_opponent",
          join_code: "ABC123",
        }}
        onlineInfo={{ playerNumber: 1 }}
        onNewGame={vi.fn()}
        onHome={vi.fn()}
      />
    );

    const inviteUrl = buildInviteUrl("ABC123", "/roster");
    expect(inviteUrl).toContain("/roster?join=ABC123");
    expect(screen.queryByTestId("searching-lobby")).not.toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText(inviteUrl)).toBeInTheDocument();
    expect(screen.getByText("Copy link")).toBeInTheDocument();
  });
});

describe("RosterGuessRaceBoard online resign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realtimeHolder.opts = null;
  });

  it("resigns through the give-up endpoint and shows the self-resign outcome", async () => {
    resignRosterRaceGame.mockResolvedValue({
      state: activeRaceGame({ status: "finished", winner_player: 2 }),
      result: "resigned",
    });

    render(
      <RosterGuessRaceBoard
        initialState={activeRaceGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Resign"));
    expect(
      screen.getByText("Resign the match? Your opponent wins.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Resign"));

    await waitFor(() => expect(resignRosterRaceGame).toHaveBeenCalledWith(30, 1));
    expect(await screen.findByText("You resigned.")).toBeInTheDocument();
  });

  it("renders an opponent resignation delivered over realtime", () => {
    render(
      <RosterGuessRaceBoard
        initialState={activeRaceGame()}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    act(() => {
      realtimeHolder.opts.onState({
        state: activeRaceGame({ status: "finished", winner_player: 2 }),
        result: "resigned",
      });
    });

    expect(screen.getByText("Your opponent resigned.")).toBeInTheDocument();
  });

  it("does not offer a resign control once the game is finished", () => {
    render(
      <RosterGuessRaceBoard
        initialState={activeRaceGame({ status: "finished", winner_player: 2 })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByText("Resign")).not.toBeInTheDocument();
  });

  it("hides the resign control during the inter-round reveal lock", () => {
    render(
      <RosterGuessRaceBoard
        initialState={activeRaceGame({
          latest_completed_round: {
            round_number: 3,
            winner_player: 1,
            player1_correct: 5,
            player2_correct: 3,
            next_round_starts_at: new Date(Date.now() + 10_000).toISOString(),
          },
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByText("Player 1 wins the round")).toBeInTheDocument();
    expect(screen.queryByText("Resign")).not.toBeInTheDocument();
  });
});

function activeRaceGame(overrides = {}) {
  return {
    id: 30,
    is_race: true,
    is_public: false,
    preset: null,
    status: "active",
    target_wins: 2,
    player1_name: "Ace",
    player2_name: "Runner",
    player1_score: 0,
    player2_score: 0,
    winner_player: null,
    round_number: 4,
    race_round_deadline_utc: new Date(Date.now() + 120_000).toISOString(),
    latest_completed_round: null,
    round: {
      id: 44,
      round_number: 4,
      status: "active",
      team_code: "RMB",
      team_name: "Real Madrid",
      season_year: 2024,
      player1_correct: 0,
      player2_correct: 0,
      guessed_count: 0,
      total_slots: 1,
      slots: [
        {
          id: 1,
          player_name: null,
          position: "Guard",
          nationality: null,
          jersey_number: null,
          image_url: null,
          guessed_by_player: null,
        },
      ],
    },
    ...overrides,
  };
}

describe("RosterGuessRaceBoard header navigation", () => {
  it("exposes a single consistent Home control that returns to the app home", () => {
    const onHome = vi.fn();
    const onNewGame = vi.fn();

    render(
      <RosterGuessRaceBoard
        initialState={activeRaceGame()}
        onlineInfo={{ playerNumber: 1 }}
        onNewGame={onNewGame}
        onHome={onHome}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));

    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onNewGame).not.toHaveBeenCalled();
  });
});
