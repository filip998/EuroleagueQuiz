import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import App from "../App";

// Mock all child components to isolate App logic
vi.mock("../GameSetup", () => ({
  default: ({ onBack }) => (
    <div data-testid="game-setup">
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../GameBoard", () => ({
  default: () => <div data-testid="game-board" />,
}));
vi.mock("../RosterGuessSetup", () => ({
  default: ({ onBack }) => (
    <div data-testid="roster-setup">
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../RosterGuessBoard", () => ({
  default: () => <div data-testid="roster-board" />,
}));
vi.mock("../HigherLowerSetup", () => ({
  default: ({ onBack }) => (
    <div data-testid="hl-setup">
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../HigherLowerBoard", () => ({
  default: () => <div data-testid="hl-board" />,
}));

describe("App", () => {
  it("renders the game selection screen with all three game modes", () => {
    render(<App />);
    expect(screen.getByText("TICTACTOE")).toBeInTheDocument();
    expect(screen.getByText("ROSTER GUESS")).toBeInTheDocument();
    expect(screen.getByText("HIGHER OR LOWER")).toBeInTheDocument();
    expect(screen.getByText("Choose your game")).toBeInTheDocument();
  });

  it("navigates to TicTacToe setup when clicking the card", () => {
    render(<App />);
    fireEvent.click(screen.getByText("TICTACTOE"));
    expect(screen.getByTestId("game-setup")).toBeInTheDocument();
  });

  it("navigates to Roster Guess setup when clicking the card", () => {
    render(<App />);
    fireEvent.click(screen.getByText("ROSTER GUESS"));
    expect(screen.getByTestId("roster-setup")).toBeInTheDocument();
  });

  it("navigates to Higher or Lower setup when clicking the card", () => {
    render(<App />);
    fireEvent.click(screen.getByText("HIGHER OR LOWER"));
    expect(screen.getByTestId("hl-setup")).toBeInTheDocument();
  });

  it("navigates back to selection when onBack is called", () => {
    render(<App />);
    fireEvent.click(screen.getByText("TICTACTOE"));
    expect(screen.getByTestId("game-setup")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("TICTACTOE")).toBeInTheDocument();
    expect(screen.getByText("ROSTER GUESS")).toBeInTheDocument();
  });
});
