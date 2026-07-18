import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GameBoard from "../GameBoard";
import { submitMove, autocompletePlayer } from "../api";

// Unlike GameBoard.test.jsx, this file intentionally does NOT mock
// "../PlayerSearch" -- the focus-restoration bug lives in the interaction
// between GameBoard's own cell `disabled` attribute and PlayerSearch's real
// useDialogFocus opener-restoration effect, so a stubbed PlayerSearch (which
// never runs useDialogFocus) cannot reproduce it.
vi.mock("../api", () => ({
  getGame: vi.fn(),
  submitMove: vi.fn(),
  offerDraw: vi.fn(),
  respondDraw: vi.fn(),
  giveUpGame: vi.fn(),
  cancelQuickMatchTicTacToe: vi.fn(),
  connectTicTacToeRealtime: vi.fn(),
  autocompletePlayer: vi.fn(),
  autocompleteGuessTheListPlayer: vi.fn(),
}));

const axis = (label) => ({ axis_type: "season", display_label: label });
const boardCells = () =>
  [0, 1, 2].flatMap((row_index) =>
    [0, 1, 2].map((col_index) => ({
      row_index,
      col_index,
      claimed_by_player: null,
      claimed_player_id: null,
      claimed_player_name: null,
    }))
  );

function activeGame(overrides = {}) {
  return {
    id: 7,
    status: "active",
    mode: "local_two_player",
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
      cells: boardCells(),
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  autocompletePlayer.mockResolvedValue({
    players: [{ player_id: 99, full_name: "Nando De Colo" }],
  });
});

describe("GameBoard keyboard focus restoration with the real PlayerSearch dialog", () => {
  it("restores focus to the attempted cell (not <body>) while a deferred HTTP move is still pending", async () => {
    let resolveSubmit;
    submitMove.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        })
    );

    const user = userEvent.setup();
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const cell = screen.getByRole("button", {
      name: /1 row and A column\. Available\. Choose a player\./,
    });
    await user.click(cell);
    expect(cell).not.toHaveFocus(); // focus moved into the opened dialog

    const input = await screen.findByPlaceholderText("Type player name...");
    await user.type(input, "nando");
    const option = await screen.findByText("Nando De Colo");
    await user.click(option);

    // The dialog has unmounted and submitMove is still pending -- the cell
    // must stay focusable (not natively `disabled`) so useDialogFocus's
    // opener-restoration effect actually lands focus on it instead of
    // silently no-oping and falling through to <body>.
    await waitFor(() => expect(cell).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    // Still visibly/accessibly blocked from a second activation while pending.
    expect(cell).toHaveAttribute("aria-disabled", "true");
    expect(cell).not.toBeDisabled();

    await act(async () => {
      resolveSubmit({
        state: activeGame({ current_player: 2 }),
        result: "correct",
      });
    });
  });

  it("still restores focus to the opener on Cancel (no move attempted)", async () => {
    const user = userEvent.setup();
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const cell = screen.getByRole("button", {
      name: /1 row and A column\. Available\. Choose a player\./,
    });
    await user.click(cell);

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cell).toHaveFocus();
    expect(submitMove).not.toHaveBeenCalled();
  });
});
