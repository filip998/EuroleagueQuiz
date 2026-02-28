import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import HigherLowerBoard from "../HigherLowerBoard";

vi.mock("../api", () => ({
  submitHigherLowerAnswer: vi.fn(),
}));

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => (
    <button data-testid="logo-mini" onClick={onClick}>Logo</button>
  ),
  LogoFull: () => <div data-testid="logo-full" />,
  default: () => <div data-testid="logo-full" />,
}));

import { submitHigherLowerAnswer } from "../api";

const mockPair = {
  category_label: "Points Per Game",
  left: { name: "Luka Doncic", nationality: "Slovenia" },
  right: { name: "Nikola Jokic", nationality: "Serbia" },
};

const mockInitialState = {
  game_id: 1,
  pair: mockPair,
};

describe("HigherLowerBoard", () => {
  const mockOnNewGame = vi.fn();
  const mockOnHome = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders both player cards with names", () => {
    render(
      <HigherLowerBoard
        initialState={mockInitialState}
        onNewGame={mockOnNewGame}
        onHome={mockOnHome}
      />
    );

    expect(screen.getByText("Luka Doncic")).toBeInTheDocument();
    expect(screen.getByText("Nikola Jokic")).toBeInTheDocument();
  });

  it("renders the category label", () => {
    render(
      <HigherLowerBoard
        initialState={mockInitialState}
        onNewGame={mockOnNewGame}
        onHome={mockOnHome}
      />
    );

    expect(screen.getByText("Points Per Game")).toBeInTheDocument();
  });

  it("renders the Same button", () => {
    render(
      <HigherLowerBoard
        initialState={mockInitialState}
        onNewGame={mockOnNewGame}
        onHome={mockOnHome}
      />
    );

    expect(screen.getByText("= Same")).toBeInTheDocument();
  });

  it("shows nationality flags", () => {
    render(
      <HigherLowerBoard
        initialState={mockInitialState}
        onNewGame={mockOnNewGame}
        onHome={mockOnHome}
      />
    );

    expect(screen.getByText("Slovenia")).toBeInTheDocument();
    expect(screen.getByText("Serbia")).toBeInTheDocument();
  });

  it("shows game over screen on wrong answer", async () => {
    submitHigherLowerAnswer.mockResolvedValue({
      correct: false,
      streak: 3,
      left_value: 20.5,
      right_value: 25.3,
      is_personal_best: true,
      leaderboard_position: 5,
    });

    render(
      <HigherLowerBoard
        initialState={mockInitialState}
        onNewGame={mockOnNewGame}
        onHome={mockOnHome}
      />
    );

    // Click left player (choose "higher")
    fireEvent.click(screen.getByText("Luka Doncic").closest("button"));

    await waitFor(() => {
      expect(screen.getByText("GAME OVER")).toBeInTheDocument();
      expect(screen.getByText("3 correct in a row!")).toBeInTheDocument();
    });
  });

  it("shows play again and home buttons on game over", async () => {
    submitHigherLowerAnswer.mockResolvedValue({
      correct: false,
      streak: 0,
      left_value: 10,
      right_value: 15,
      is_personal_best: false,
      leaderboard_position: 99,
    });

    render(
      <HigherLowerBoard
        initialState={mockInitialState}
        onNewGame={mockOnNewGame}
        onHome={mockOnHome}
      />
    );

    fireEvent.click(screen.getByText("= Same"));

    await waitFor(() => {
      expect(screen.getByText("Play Again")).toBeInTheDocument();
      expect(screen.getByText("Home")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Play Again"));
    expect(mockOnNewGame).toHaveBeenCalled();
  });

  it("shows streak count after correct answer", async () => {
    submitHigherLowerAnswer.mockResolvedValue({
      correct: true,
      streak: 1,
      left_value: 25,
      right_value: 20,
      next_pair: mockPair,
    });

    render(
      <HigherLowerBoard
        initialState={mockInitialState}
        onNewGame={mockOnNewGame}
        onHome={mockOnHome}
      />
    );

    fireEvent.click(screen.getByText("Luka Doncic").closest("button"));

    await waitFor(() => {
      expect(screen.getByText("Correct!")).toBeInTheDocument();
    });
  });

  it("displays the header with HIGHER OR LOWER title", () => {
    render(
      <HigherLowerBoard
        initialState={mockInitialState}
        onNewGame={mockOnNewGame}
        onHome={mockOnHome}
      />
    );

    expect(screen.getByText("HIGHER OR LOWER")).toBeInTheDocument();
  });
});
