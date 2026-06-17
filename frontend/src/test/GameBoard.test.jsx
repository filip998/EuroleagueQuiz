import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import GameBoard from "../GameBoard";
import { giveUpGame, cancelQuickMatchTicTacToe } from "../api";
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

    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: 1 }),
        result: "opponent_left",
      });
    });

    // Player 2 lost the disconnect race here.
    expect(await screen.findByText("You left the game.")).toBeInTheDocument();
    // The terminal banner is suppressed in favour of the finished-screen subtitle.
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });
});
