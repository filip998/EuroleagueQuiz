import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App, { HomePage } from "../App";

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
vi.mock("../GuessTheListSetup", () => ({
  default: ({ onBack, initialMode, initialOnlineGameType, initialJoinCode }) => (
    <div
      data-testid="guess-the-list-setup"
      data-initial-mode={initialMode || ""}
      data-initial-online-game-type={initialOnlineGameType || ""}
      data-initial-join-code={initialJoinCode || ""}
    >
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../GuessTheListBoard", () => ({
  default: () => <div data-testid="guess-the-list-board" />,
}));
vi.mock("../GuessTheListRaceBoard", () => ({
  default: () => <div data-testid="guess-the-list-race-board" />,
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
    expect(screen.getByText("TIC-TAC-TOE")).toBeInTheDocument();
    expect(screen.getByText("GUESS THE LIST")).toBeInTheDocument();
    expect(screen.getByText("HIGHER OR LOWER")).toBeInTheDocument();
    expect(screen.getByText("CAREER QUIZ")).toBeInTheDocument();
    expect(screen.getByText("PHOTO QUIZ")).toBeInTheDocument();
    expect(screen.getByText("Choose your game")).toBeInTheDocument();
  });

  it("navigates to TicTacToe setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("TIC-TAC-TOE"));
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

  it("navigates to Guess the List setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("GUESS THE LIST"));
    expect(screen.getByTestId("guess-the-list-setup")).toBeInTheDocument();
  });

  it("renders a Quick Match CTA on the Guess the List card that opens Race setup", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const cta = screen
      .getAllByTestId("home-quick-match-cta")
      .find((el) => el.getAttribute("href") === "/list?quick=1");
    expect(cta).toBeDefined();
    expect(cta).toHaveTextContent("Quick Match");
    fireEvent.click(cta);
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toBeInTheDocument();
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-online-game-type", "race");
  });

  it("redirects legacy /roster quick links to the Guess the List setup without losing the query", () => {
    render(
      <MemoryRouter initialEntries={["/roster?quick=1"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toBeInTheDocument();
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-online-game-type", "race");
  });

  it("opens Guess the List Online → Classic → Join with a prefilled code from /list?join=", () => {
    render(
      <MemoryRouter initialEntries={["/list?join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-online-game-type", "classic");
    expect(setup).toHaveAttribute("data-initial-join-code", "ABC123");
  });

  it("opens Guess the List Online → Race friend join from /list?mode=race&join=", () => {
    render(
      <MemoryRouter initialEntries={["/list?mode=race&join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-online-game-type", "race");
    expect(setup).toHaveAttribute("data-initial-join-code", "ABC123");
  });

  it("keeps /list?quick=1 on Race Quick Match and ignores any invite code", () => {
    render(
      <MemoryRouter initialEntries={["/list?quick=1&join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-online-game-type", "race");
    expect(setup).toHaveAttribute("data-initial-join-code", "");
  });

  it("ignores an invalid /list?join= code and falls back to Solo setup", () => {
    render(
      <MemoryRouter initialEntries={["/list?join=bad"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "solo");
    expect(setup).toHaveAttribute("data-initial-online-game-type", "classic");
    expect(setup).toHaveAttribute("data-initial-join-code", "");
  });

  it("redirects legacy /roster?join= to Guess setup Classic join preserving the code", () => {
    render(
      <MemoryRouter initialEntries={["/roster?join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-online-game-type", "classic");
    expect(setup).toHaveAttribute("data-initial-join-code", "ABC123");
  });

  it("redirects legacy /roster?mode=race&join= to Guess setup Race friend join", () => {
    render(
      <MemoryRouter initialEntries={["/roster?mode=race&join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-online-game-type", "race");
    expect(setup).toHaveAttribute("data-initial-join-code", "ABC123");
  });

  it("navigates to Higher or Lower setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("HIGHER OR LOWER"));
    expect(screen.getByTestId("hl-setup")).toBeInTheDocument();
  });

  it("renders a persistent Play CTA on the Higher or Lower card that opens setup", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const cta = screen.getByTestId("home-play-cta");
    // Persistent: present in the DOM without any hover interaction...
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute("href", "/higherlower");
    expect(cta).toHaveTextContent("Play");
    // ...and rendered as the shared CTA button, not the old hover-only text.
    expect(cta.className).toContain("bg-elq-cta");
    expect(cta.className).not.toContain("opacity-0");
    expect(cta.className).not.toContain("group-hover:opacity-100");
    fireEvent.click(cta);
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
    fireEvent.click(screen.getByText("TIC-TAC-TOE"));
    expect(screen.getByTestId("game-setup")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Back"));
    expect(screen.getByText("TIC-TAC-TOE")).toBeInTheDocument();
    expect(screen.getByText("GUESS THE LIST")).toBeInTheDocument();
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

describe("HomePage UI variant", () => {
  it("renders the classic home when variant is 'classic'", () => {
    render(<MemoryRouter><HomePage variant="classic" /></MemoryRouter>);
    expect(screen.getByText("TICTACTOE")).toBeInTheDocument();
    expect(screen.queryByText("TIC-TAC-TOE")).not.toBeInTheDocument();
    expect(screen.queryByText(/how well do you know/i)).not.toBeInTheDocument();
  });

  it("renders the refined home when variant is 'refined'", () => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);
    expect(screen.getByText("TIC-TAC-TOE")).toBeInTheDocument();
    expect(screen.getByText(/how well do you know/i)).toBeInTheDocument();
    expect(screen.queryByText("TICTACTOE")).not.toBeInTheDocument();
  });

  it("renders every game mode and the section heading in both variants", () => {
    for (const variant of ["classic", "refined"]) {
      const { unmount } = render(
        <MemoryRouter><HomePage variant={variant} /></MemoryRouter>
      );
      expect(screen.getByText("Choose your game")).toBeInTheDocument();
      expect(screen.getByText("GUESS THE LIST")).toBeInTheDocument();
      expect(screen.getByText("HIGHER OR LOWER")).toBeInTheDocument();
      expect(screen.getByText("CAREER QUIZ")).toBeInTheDocument();
      expect(screen.getByText("PHOTO QUIZ")).toBeInTheDocument();
      unmount();
    }
  });

  it("shows the flagship 'how it works' steps in refined but not classic", () => {
    const { unmount } = render(
      <MemoryRouter><HomePage variant="refined" /></MemoryRouter>
    );
    expect(
      screen.getByText("Name a player who fits both clues")
    ).toBeInTheDocument();
    unmount();

    render(<MemoryRouter><HomePage variant="classic" /></MemoryRouter>);
    expect(
      screen.queryByText("Name a player who fits both clues")
    ).not.toBeInTheDocument();
  });
});
