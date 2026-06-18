import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import GameBoard from "../GameBoard";
import { giveUpGame, cancelQuickMatchTicTacToe } from "../api";
import { clearOnlineInfo } from "../onlineRecovery";
import { forgetQuickMatchSeat } from "../quickMatchSeats";
import { buildInviteUrl } from "../inviteLink";

// Capture the options GameBoard hands to the realtime hook so tests can drive
// server-pushed state (e.g. a disconnect forfeit) without a real WebSocket.
const realtimeHolder = vi.hoisted(() => ({ opts: null }));
vi.mock("../useOnlineGameRealtime", () => ({
  useOnlineGameRealtime: (opts) => {
    realtimeHolder.opts = opts;
    return {};
  },
}));

vi.mock("../api", () => ({
  getGame: vi.fn(),
  submitMove: vi.fn(),
  offerDraw: vi.fn(),
  respondDraw: vi.fn(),
  giveUpGame: vi.fn(),
  cancelQuickMatchTicTacToe: vi.fn(),
  connectTicTacToeRealtime: vi.fn(),
}));

// Recovery cleanup on cancel is asserted via these spies; the real behaviour is
// covered in onlineRecovery.test.js / quickMatchSeats.test.js.
vi.mock("../onlineRecovery", () => ({ clearOnlineInfo: vi.fn() }));
vi.mock("../quickMatchSeats", () => ({ forgetQuickMatchSeat: vi.fn() }));

// Stubs that capture the props GameBoard hands to the two waiting screens.
vi.mock("../WaitingLobby", () => ({
  default: ({ joinCode, inviteUrl }) => (
    <div
      data-testid="waiting-lobby"
      data-join-code={joinCode}
      data-invite-url={inviteUrl}
    />
  ),
}));

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

const axis = (label) => ({ axis_type: "season", display_label: label });

function activeGame(overrides = {}) {
  return {
    id: 7,
    status: "active",
    mode: "online_friend",
    is_public: false,
    preset: null,
    current_player: 1,
    player1_name: "Alice",
    player2_name: "Bob",
    player1_score: 0,
    player2_score: 0,
    winner_player: null,
    round_number: 1,
    target_wins: 3,
    turn_seconds: null,
    round: {
      columns: [axis("A"), axis("B"), axis("C")],
      rows: [axis("1"), axis("2"), axis("3")],
      cells: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  realtimeHolder.opts = null;
});

describe("GameBoard waiting lobby", () => {
  it("passes a shareable invite URL built from the join code", () => {
    render(
      <GameBoard
        initialState={{ id: 7, status: "waiting_for_opponent", join_code: "ABC123" }}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    const lobby = screen.getByTestId("waiting-lobby");
    expect(lobby).toHaveAttribute("data-join-code", "ABC123");
    expect(lobby).toHaveAttribute("data-invite-url", buildInviteUrl("ABC123"));
  });

  it("shows the Quick Match searching lobby for a public preset game", () => {
    render(
      <GameBoard
        initialState={{
          id: 8,
          status: "waiting_for_opponent",
          is_public: true,
          preset: "blitz",
        }}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    expect(screen.getByTestId("searching-lobby")).toHaveAttribute("data-preset", "blitz");
    expect(screen.queryByTestId("waiting-lobby")).not.toBeInTheDocument();
  });

  it("cancels a quick match search via the cancel endpoint", async () => {
    cancelQuickMatchTicTacToe.mockResolvedValue({ state: { id: 8, status: "cancelled" } });
    const onNewGame = vi.fn();
    render(
      <GameBoard
        initialState={{
          id: 8,
          status: "waiting_for_opponent",
          is_public: true,
          preset: "blitz",
        }}
        onNewGame={onNewGame}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    fireEvent.click(screen.getByText("stub-cancel"));

    await waitFor(() =>
      expect(cancelQuickMatchTicTacToe).toHaveBeenCalledWith({
        preset: "blitz",
        game_id: 8,
      })
    );
    await waitFor(() => expect(onNewGame).toHaveBeenCalled());
    // The deleted waiting row frees its id for reuse, so recovery data for that
    // id must be dropped to avoid mis-seating a later game as the wrong player.
    expect(clearOnlineInfo).toHaveBeenCalledWith(8);
    expect(forgetQuickMatchSeat).toHaveBeenCalledWith(8);
  });

  it("keeps recovery data when a cancel fails (search already matched)", async () => {
    cancelQuickMatchTicTacToe.mockRejectedValue(new Error("already matched"));
    const onNewGame = vi.fn();
    render(
      <GameBoard
        initialState={{
          id: 8,
          status: "waiting_for_opponent",
          is_public: true,
          preset: "blitz",
        }}
        onNewGame={onNewGame}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    fireEvent.click(screen.getByText("stub-cancel"));

    await waitFor(() => expect(cancelQuickMatchTicTacToe).toHaveBeenCalled());
    // A rejected cancel means the game still exists (it just matched); staying on
    // the board lets the realtime hook flip it to active, so we must NOT discard
    // the recovery data that keeps this client seated correctly.
    expect(clearOnlineInfo).not.toHaveBeenCalled();
    expect(forgetQuickMatchSeat).not.toHaveBeenCalled();
    expect(onNewGame).not.toHaveBeenCalled();
  });
});

describe("GameBoard online resign", () => {
  it("resigns through the HTTP give-up endpoint and shows the self-resign outcome", async () => {
    // Player 1 resigns, so the backend awards the win to player 2 and the
    // resigning viewer (player 1) must see the "You resigned." subtitle.
    giveUpGame.mockResolvedValue({
      state: activeGame({ status: "finished", winner_player: 2 }),
      result: "resigned",
    });

    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    // First click reveals the confirm dialog, second click confirms.
    fireEvent.click(screen.getByText("Resign"));
    fireEvent.click(screen.getByText("Resign"));

    await waitFor(() => expect(giveUpGame).toHaveBeenCalledWith(7, 1));
    expect(await screen.findByText("You resigned.")).toBeInTheDocument();
  });

  it("renders an opponent resignation delivered over realtime", async () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    // The opponent (player 1) resigned remotely, so player 2 wins and sees the
    // opponent-perspective subtitle (the iWon branch).
    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: 2 }),
        result: "resigned",
      });
    });

    expect(await screen.findByText("Your opponent resigned.")).toBeInTheDocument();
  });

  it("renders a disconnect forfeit delivered over realtime", async () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    // The grace timer only fires once the opponent is already disconnected, so
    // the terminal `opponent_left` broadcast only ever reaches the still-connected
    // winner. Here player 2 wins because player 1 left.
    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: 2 }),
        result: "opponent_left",
      });
    });

    expect(await screen.findByText("Your opponent left the game.")).toBeInTheDocument();
    // The terminal banner is suppressed in favour of the finished-screen subtitle.
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });
});

describe("GameBoard end-of-game result", () => {
  it("reveals the inline result and clears the waiting indicator when the opponent resigns", async () => {
    // Player 2 is the viewer and it is player 1's turn, so the stale-prone
    // "Waiting for opponent..." indicator is on screen before the match ends.
    render(
      <GameBoard
        initialState={activeGame({ current_player: 1 })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    expect(screen.getByText("Waiting for opponent...")).toBeInTheDocument();

    // Player 1 resigns remotely; player 2 wins. The result must surface on the
    // inline result screen and the waiting indicator must vanish once the game
    // is no longer active.
    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: 2, current_player: 1 }),
        result: "resigned",
      });
    });

    expect(await screen.findByText("Your opponent resigned.")).toBeInTheDocument();
    expect(screen.getByText(/WINS!/)).toBeInTheDocument();
    expect(screen.queryByText("Waiting for opponent...")).not.toBeInTheDocument();
  });

  it("shows the result only after the round transition for a normal final-round win", () => {
    vi.useFakeTimers();
    try {
      render(
        <GameBoard
          initialState={activeGame()}
          onNewGame={() => {}}
          onHome={() => {}}
          onlineInfo={{ isOnline: true, playerNumber: 1 }}
        />
      );

      // A match-winning move flows through the shared 3s round transition, during
      // which the result screen stays hidden (no flicker of the final reveal).
      act(() => {
        realtimeHolder.opts.onState({
          state: activeGame({ status: "finished", winner_player: 1 }),
          result: "match_won",
          completedRound: {
            columns: [axis("A"), axis("B"), axis("C")],
            rows: [axis("1"), axis("2"), axis("3")],
            cells: [],
          },
        });
      });

      expect(screen.queryByText(/WINS!/)).not.toBeInTheDocument();

      // The countdown reschedules a fresh 1s timeout after each React flush, so
      // advance it one second at a time until the transition clears.
      for (let i = 0; i < 4; i++) {
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }

      // After the transition the result appears with the generic, perspective-aware
      // win line (no forfeit reason for a normal win).
      expect(screen.getByText(/WINS!/)).toBeInTheDocument();
      expect(screen.getByText("You won the match!")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a persistent inline result with no dismiss control", async () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: 2 }),
        result: "resigned",
      });
    });

    // The unified result screen replaces the board inline — it is not a
    // dismissible modal, so the forfeit reason and winner stay on screen.
    expect(await screen.findByText("Your opponent resigned.")).toBeInTheDocument();
    expect(screen.getByText(/WINS!/)).toBeInTheDocument();

    // The old dismissible modal is gone: no Close button, no "View result" pill,
    // and no dialog role to dismiss.
    expect(screen.queryByLabelText("Close")).toBeNull();
    expect(screen.queryByText("View result")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    // The end-of-game actions use the standardized, cross-game labels.
    expect(screen.getByText("Play Again")).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
  });

  it("does not render the result screen for a finished solo game", () => {
    render(
      <GameBoard
        initialState={activeGame({ mode: "single_player", status: "finished", winner_player: 1 })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    // Solo games keep their final board (the shared result screen is online-only),
    // so neither the winner headline nor the Play Again action appears.
    expect(screen.queryByText(/WINS!/)).not.toBeInTheDocument();
    expect(screen.queryByText("Play Again")).not.toBeInTheDocument();
  });

  it("does not credit Player 2 when a finished online game has no winner", async () => {
    render(
      <GameBoard
        initialState={activeGame({ current_player: 1 })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    // A null winner must not fall through to the Player 2 name; the shared
    // winnerDisplayName helper renders a neutral "No winner" headline.
    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: null }),
      });
    });

    expect(await screen.findByRole("heading", { name: "No winner" })).toBeInTheDocument();
    expect(screen.queryByText("Bob WINS!")).not.toBeInTheDocument();
  });
});

describe("GameBoard header navigation", () => {
  it("exposes a single consistent Home control that returns to the app home", () => {
    const onHome = vi.fn();
    const onNewGame = vi.fn();

    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={onNewGame}
        onHome={onHome}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));

    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onNewGame).not.toHaveBeenCalled();
    // The previous centered logo nav is gone, leaving a single home affordance.
    expect(screen.queryByRole("button", { name: "EuroLeague Quiz" })).toBeNull();
  });

  it("renders the unified online scoreboard with a seat-colored self-indicator", () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={vi.fn()}
        onHome={vi.fn()}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    const scoreboard = screen.getByLabelText("TicTacToe multiplayer scoreboard");
    expect(within(scoreboard).getByText("Alice")).toBeInTheDocument();
    expect(within(scoreboard).getByText("Bob")).toBeInTheDocument();
    expect(within(scoreboard).getByText("Round 1")).toBeInTheDocument();
    expect(within(scoreboard).getByText("First to 3")).toBeInTheDocument();

    const pill = within(scoreboard).getByText("You are Alice").closest("div");
    expect(pill.querySelector(".bg-elq-player1")).toBeTruthy();
  });
});

describe("GameBoard solo / local never shows the online Resign control (issue #150)", () => {
  // A stale `elq_game_<id>` seat (from an earlier online game whose numeric id was
  // later reused by a brand-new solo/local game) can hand the board a truthy
  // `onlineInfo`. The board must still refuse to go online based on the game mode.
  const staleSeat = { isOnline: true, playerNumber: 1 };

  it("renders only Give Up (no Resign) for a single_player game with a stale seat", () => {
    render(
      <GameBoard
        initialState={activeGame({ mode: "single_player" })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={staleSeat}
      />
    );

    expect(screen.getByText("Give Up")).toBeInTheDocument();
    expect(screen.queryByText("Resign")).not.toBeInTheDocument();
    // The leak is behavioural too: the realtime transport must stay disabled.
    expect(realtimeHolder.opts.enabled).toBe(false);
  });

  it("renders no Resign for a local_two_player game with a stale seat", () => {
    render(
      <GameBoard
        initialState={activeGame({ mode: "local_two_player" })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={staleSeat}
      />
    );

    expect(screen.queryByText("Resign")).not.toBeInTheDocument();
    expect(realtimeHolder.opts.enabled).toBe(false);
  });
});
