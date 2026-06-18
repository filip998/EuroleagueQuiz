import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";

// Mock all child components to isolate App logic
vi.mock("../GameSetup", () => ({
  default: ({ onBack, initialJoinCode }) => (
    <div data-testid="game-setup" data-initial-join-code={initialJoinCode || ""}>
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../GameBoard", () => ({
  default: () => <div data-testid="game-board" />,
}));
vi.mock("../RosterGuessSetup", () => ({
  default: ({ onBack, initialMode, initialGameType }) => (
    <div
      data-testid="roster-setup"
      data-initial-mode={initialMode || ""}
      data-initial-game-type={initialGameType || ""}
    >
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
vi.mock("../CareerQuizSetup", () => ({
  default: ({ onBack }) => (
    <div data-testid="career-setup">
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../CareerQuizBoard", () => ({
  default: () => <div data-testid="career-board" />,
}));
vi.mock("../PhotoQuizSetup", () => ({
  default: ({ onBack, initialMode }) => (
    <div data-testid="photo-setup" data-initial-mode={initialMode || ""}>
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../PhotoQuizBoard", () => ({
  default: () => <div data-testid="photo-board" />,
}));

describe("App", () => {
  it("renders the game selection screen with all game modes", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(screen.getByText("TICTACTOE")).toBeInTheDocument();
    expect(screen.getByText("ROSTER GUESS")).toBeInTheDocument();
    expect(screen.getByText("HIGHER OR LOWER")).toBeInTheDocument();
    expect(screen.getByText("CAREER QUIZ")).toBeInTheDocument();
    expect(screen.getByText("PHOTO QUIZ")).toBeInTheDocument();
    expect(screen.getByText("Choose your game")).toBeInTheDocument();
  });

  it("navigates to TicTacToe setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("TICTACTOE"));
    expect(screen.getByTestId("game-setup")).toBeInTheDocument();
  });

  it("renders a Quick Match CTA on the TicTacToe card that opens setup", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const cta = screen
      .getAllByTestId("home-quick-match-cta")
      .find((el) => el.getAttribute("href") === "/tictactoe");
    expect(cta).toBeDefined();
    expect(cta).toHaveTextContent("Quick Match");
    fireEvent.click(cta);
    expect(screen.getByTestId("game-setup")).toBeInTheDocument();
  });

  it("renders a Quick Match CTA on the Photo Quiz card that opens setup on Online", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const cta = screen
      .getAllByTestId("home-quick-match-cta")
      .find((el) => el.getAttribute("href") === "/photo?quick=1");
    expect(cta).toBeDefined();
    expect(cta).toHaveTextContent("Quick Match");
    fireEvent.click(cta);
    const setup = screen.getByTestId("photo-setup");
    expect(setup).toBeInTheDocument();
    expect(setup).toHaveAttribute("data-initial-mode", "online");
  });

  it("navigates to Roster Guess setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("ROSTER GUESS"));
    expect(screen.getByTestId("roster-setup")).toBeInTheDocument();
  });

  it("renders a Quick Match CTA on the Roster Guess card that opens Race setup", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const cta = screen
      .getAllByTestId("home-quick-match-cta")
      .find((el) => el.getAttribute("href") === "/roster?quick=1");
    expect(cta).toBeDefined();
    expect(cta).toHaveTextContent("Quick Match");
    fireEvent.click(cta);
    const setup = screen.getByTestId("roster-setup");
    expect(setup).toBeInTheDocument();
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-game-type", "race");
  });

  it("navigates to Higher or Lower setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("HIGHER OR LOWER"));
    expect(screen.getByTestId("hl-setup")).toBeInTheDocument();
  });

  it("navigates to Career Quiz setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("CAREER QUIZ"));
    expect(screen.getByTestId("career-setup")).toBeInTheDocument();
  });

  it("navigates to Photo Quiz setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("PHOTO QUIZ"));
    expect(screen.getByTestId("photo-setup")).toBeInTheDocument();
  });

  it("navigates back to selection when onBack is called", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("TICTACTOE"));
    expect(screen.getByTestId("game-setup")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("TICTACTOE")).toBeInTheDocument();
    expect(screen.getByText("ROSTER GUESS")).toBeInTheDocument();
  });

  it("prefills the TicTacToe setup join code from a ?join= invite URL", () => {
    render(
      <MemoryRouter initialEntries={["/tictactoe?join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByTestId("game-setup")).toHaveAttribute(
      "data-initial-join-code",
      "ABC123"
    );
  });

  it("normalizes an invalid ?join= invite code to empty", () => {
    render(
      <MemoryRouter initialEntries={["/tictactoe?join=bad"]}>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByTestId("game-setup")).toHaveAttribute(
      "data-initial-join-code",
      ""
    );
  });
});
