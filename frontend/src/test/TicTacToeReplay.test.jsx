import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Keep the real api module (so App + GameBoard resolve every export) but stub the
// two functions this flow drives: getGame (route hydration) and createGame (the
// solo "Play Again" replay).
const getGameMock = vi.fn();
const createGameMock = vi.fn();
vi.mock("../api", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    getGame: (...args) => getGameMock(...args),
    createGame: (...args) => createGameMock(...args),
  };
});

// GameBoard renders for real so we exercise the real "Play Again" button; only the
// realtime transport is stubbed (solo/local never connect anyway).
vi.mock("../useOnlineGameRealtime", () => ({
  useOnlineGameRealtime: () => ({}),
}));

import { TicTacToeGamePage } from "../App";

const axis = (label) => ({ axis_type: "season", display_label: label });
const boardCells = () =>
  [0, 1, 2].flatMap((row_index) =>
    [0, 1, 2].map((col_index) => ({
      row_index,
      col_index,
      claimed_by_player: null,
      claimed_player_id: null,
      claimed_player_name: null,
      sample_answers: ["Vasilije Micic"],
    }))
  );

function finishedSoloGame(id) {
  return {
    id,
    status: "finished",
    mode: "single_player",
    is_public: false,
    preset: null,
    current_player: 1,
    player1_name: "Solo Ace",
    player2_name: "",
    player1_score: 1,
    player2_score: 0,
    winner_player: 1,
    round_number: 1,
    target_wins: 3,
    turn_seconds: null,
    solo_progress: {
      claimed_cells: 3,
      total_cells: 9,
      strikes_used: 0,
      strikes_remaining: 3,
      strike_limit: 3,
      boards_won: 1,
    },
    round: {
      columns: [axis("A"), axis("B"), axis("C")],
      rows: [axis("1"), axis("2"), axis("3")],
      status: "completed",
      winner_player: 1,
      cells: boardCells(),
    },
  };
}

function finishedLocalGame(id) {
  return {
    ...finishedSoloGame(id),
    mode: "local_two_player",
    player1_name: "Alice",
    player2_name: "Bob",
    solo_progress: undefined,
  };
}

function renderRoute(initialId) {
  return render(
    <MemoryRouter initialEntries={[`/tictactoe/${initialId}`]}>
      <Routes>
        <Route path="/tictactoe/:gameId" element={<TicTacToeGamePage />} />
        <Route path="/tictactoe" element={<div>setup-stub</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TicTacToe solo Play Again", () => {
  it("creates a fresh solo game and navigates straight into it", async () => {
    getGameMock.mockImplementation((id) =>
      Promise.resolve(finishedSoloGame(Number(id)))
    );
    createGameMock.mockResolvedValue({ kind: "state", state: { id: 8 } });

    renderRoute(7);

    expect(
      await screen.findByRole("heading", { name: "Solo board won!" })
    ).toBeInTheDocument();
    expect(getGameMock).toHaveBeenCalledWith("7");

    fireEvent.click(await screen.findByText("Play Again"));

    // Solo replay starts a brand-new single_player board with the solo defaults.
    await waitFor(() =>
      expect(createGameMock).toHaveBeenCalledWith({
        mode: "single_player",
        timer_mode: "unlimited",
      })
    );
    // The new board is hydrated from its own route id; setup is never shown.
    await waitFor(() => expect(getGameMock).toHaveBeenCalledWith("8"));
    expect(screen.queryByText("setup-stub")).not.toBeInTheDocument();
  });

  it("returns local/online matches to the setup screen without creating a game", async () => {
    getGameMock.mockImplementation((id) =>
      Promise.resolve(finishedLocalGame(Number(id)))
    );

    renderRoute(7);

    fireEvent.click(await screen.findByText("Play Again"));

    expect(await screen.findByText("setup-stub")).toBeInTheDocument();
    expect(createGameMock).not.toHaveBeenCalled();
  });
});
