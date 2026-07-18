import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

function soloGame(overrides = {}) {
  return activeGame({
    mode: "single_player",
    player1_name: "Solo Ace",
    player2_name: "",
    current_player: 1,
    solo_progress: {
      claimed_cells: 0,
      total_cells: 9,
      strikes_used: 0,
      strikes_remaining: 3,
      strike_limit: 3,
      boards_won: 0,
    },
    ...overrides,
  });
}

const boardRegion = () => document.querySelector('[aria-label="TicTacToe board"]');

async function openPickerAndSelect(user, cellPattern) {
  const cell = screen.getByRole("button", { name: cellPattern });
  await user.click(cell);
  const input = await screen.findByPlaceholderText("Type player name...");
  await user.type(input, "nando");
  const option = await screen.findByText("Nando De Colo");
  await user.click(option);
  return cell;
}

beforeEach(() => {
  vi.clearAllMocks();
  autocompletePlayer.mockResolvedValue({
    players: [{ player_id: 99, full_name: "Nando De Colo" }],
  });
});

afterEach(() => {
  vi.useRealTimers();
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

  it("keeps focus on the attempted cell after an incorrect Local 1v1 guess resolves (game stays active)", async () => {
    submitMove.mockResolvedValue({
      state: activeGame({ current_player: 2 }),
      result: "incorrect",
      feedback: { message: "No match for both clues." },
    });

    const user = userEvent.setup();
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const cell = await openPickerAndSelect(
      user,
      /1 row and A column\. Available\. Choose a player\./
    );

    // The guess was wrong but the cell was never claimed, so it goes right
    // back to being a normal (non-natively-disabled) button -- focus should
    // simply stay put rather than needing any recovery.
    await waitFor(() => expect(cell).toHaveFocus());
    expect(cell).not.toBeDisabled();
    expect(cell).toHaveAttribute("aria-disabled", "true");
  });

  it("moves focus to the board region after a correct Local 1v1 claim resolves (game continues)", async () => {
    submitMove.mockResolvedValue({
      state: activeGame({
        current_player: 2,
        round: {
          columns: [axis("A"), axis("B"), axis("C")],
          rows: [axis("1"), axis("2"), axis("3")],
          cells: boardCells().map((cell, i) =>
            i === 0
              ? {
                  ...cell,
                  claimed_by_player: 1,
                  claimed_player_id: 99,
                  claimed_player_name: "Nando De Colo",
                }
              : cell
          ),
        },
      }),
      result: "correct",
    });

    const user = userEvent.setup();
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const cell = await openPickerAndSelect(
      user,
      /1 row and A column\. Available\. Choose a player\./
    );

    // The claim is permanent -- the button is genuinely gone from the
    // interactive set for this round, so focus must move to a stable target
    // instead of falling through to <body>.
    await waitFor(() => expect(boardRegion()).toHaveFocus());
    expect(cell).toBeDisabled();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("moves focus to Play Again once the round-transition countdown clears after a match-ending claim", async () => {
    // A match_won result still passes through the ~3s "Next round in N..."
    // transition banner before the terminal Play Again screen actually
    // mounts. Real timers keep this simple/robust (fake timers fight with
    // testing-library's own setTimeout-based polling in waitFor/findBy*); the
    // final assertion just waits comfortably past the real 3s countdown.
    const user = userEvent.setup();

    const revealRound = {
      columns: [axis("A"), axis("B"), axis("C")],
      rows: [axis("1"), axis("2"), axis("3")],
      status: "completed",
      winner_player: 1,
      cells: boardCells().map((cell, i) =>
        i === 0
          ? {
              ...cell,
              claimed_by_player: 1,
              claimed_player_id: 99,
              claimed_player_name: "Nando De Colo",
            }
          : cell
      ),
    };
    submitMove.mockResolvedValue({
      state: activeGame({
        status: "finished",
        winner_player: 1,
        player1_score: 3,
        round: revealRound,
      }),
      result: "match_won",
      completedRound: revealRound,
    });

    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    await openPickerAndSelect(
      user,
      /1 row and A column\. Available\. Choose a player\./
    );

    // Mid round-transition banner: the terminal screen isn't mounted yet, so
    // focus holds on the still-rendered, still-stable board instead of
    // falling through to <body>.
    await waitFor(() => expect(boardRegion()).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);

    // The real ~3s countdown elapses -- the terminal screen mounts and Play
    // Again becomes the meaningful, stable resting place for focus.
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: "Play Again" })).toHaveFocus(),
      { timeout: 4500 }
    );
    expect(document.activeElement).not.toBe(document.body);
  }, 10000);

  it("moves focus to Play Again when Solo strikes run out (incorrect outcome that ends the game, no enabled cell exists)", async () => {
    const revealRound = {
      columns: [axis("A"), axis("B"), axis("C")],
      rows: [axis("1"), axis("2"), axis("3")],
      status: "drawn",
      winner_player: null,
      cells: boardCells().map((cell) => ({ ...cell, sample_answers: ["Vasilije Micic"] })),
    };
    submitMove.mockResolvedValue({
      state: soloGame({
        status: "finished",
        winner_player: null,
        solo_progress: {
          claimed_cells: 0,
          total_cells: 9,
          strikes_used: 3,
          strikes_remaining: 0,
          strike_limit: 3,
          boards_won: 0,
        },
        round: revealRound,
      }),
      result: "solo_lost",
      completedRound: revealRound,
    });

    const user = userEvent.setup();
    render(
      <GameBoard
        initialState={soloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    await openPickerAndSelect(
      user,
      /1 row and A column\. Available\. Choose a player\./
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Play Again" })).toHaveFocus()
    );
    expect(document.activeElement).not.toBe(document.body);
    // The board really has no enabled cell in this terminal state.
    expect(
      screen.queryByRole("button", { name: /Choose a player/ })
    ).not.toBeInTheDocument();
  });

  it("moves focus to the board region after a correct Solo claim keeps the board going (not the final claim)", async () => {
    submitMove.mockResolvedValue({
      state: soloGame({
        round: {
          columns: [axis("A"), axis("B"), axis("C")],
          rows: [axis("1"), axis("2"), axis("3")],
          cells: boardCells().map((cell, i) =>
            i === 0
              ? {
                  ...cell,
                  claimed_by_player: 1,
                  claimed_player_id: 99,
                  claimed_player_name: "Nando De Colo",
                }
              : cell
          ),
        },
        solo_progress: {
          claimed_cells: 1,
          total_cells: 9,
          strikes_used: 0,
          strikes_remaining: 3,
          strike_limit: 3,
          boards_won: 0,
        },
      }),
      result: "correct",
    });

    const user = userEvent.setup();
    render(
      <GameBoard
        initialState={soloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const cell = await openPickerAndSelect(
      user,
      /1 row and A column\. Available\. Choose a player\./
    );

    await waitFor(() => expect(boardRegion()).toHaveFocus());
    expect(cell).toBeDisabled();
    expect(document.activeElement).not.toBe(document.body);
  });
});
