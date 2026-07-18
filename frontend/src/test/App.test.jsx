import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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
  default: ({ onBack, applyPreferences }) => (
    <div data-testid="hl-setup" data-apply-preferences={String(Boolean(applyPreferences))}>
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../HigherLowerBoard", () => ({
  default: ({ onNewGame }) => (
    <div data-testid="hl-board">
      <button onClick={onNewGame}>Play Again</button>
    </div>
  ),
}));
vi.mock("../CareerQuizSetup", () => ({
  default: ({ onBack, initialMode, initialJoinCode }) => (
    <div
      data-testid="career-setup"
      data-initial-mode={initialMode || ""}
      data-initial-join-code={initialJoinCode || ""}
    >
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
vi.mock("../CareerQuizBoard", () => ({
  default: () => <div data-testid="career-board" />,
}));
vi.mock("../PhotoQuizSetup", () => ({
  default: ({ onBack, initialMode, initialJoinCode }) => (
    <div
      data-testid="photo-setup"
      data-initial-mode={initialMode || ""}
      data-initial-join-code={initialJoinCode || ""}
    >
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
    expect(screen.getByRole("heading", { name: /choose your game/i })).toBeInTheDocument();
  });

  it("navigates to TicTacToe setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("TIC-TAC-TOE"));
    expect(screen.getByTestId("game-setup")).toBeInTheDocument();
  });

  it("renders a featured TicTacToe row that opens setup", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const row = screen.getByRole("link", { name: /most played.*tic-tac-toe.*play/i });
    expect(row).toHaveAttribute("href", "/tictactoe");
    fireEvent.click(row);
    expect(screen.getByTestId("game-setup")).toBeInTheDocument();
  });

  it("opens Photo Quiz setup on its Solo default from the launcher row", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const row = screen.getByRole("link", { name: /photo quiz/i });
    expect(row).toHaveAttribute("href", "/photo");
    fireEvent.click(row);
    const setup = screen.getByTestId("photo-setup");
    expect(setup).toBeInTheDocument();
    expect(setup).toHaveAttribute("data-initial-mode", "solo");
  });

  it("navigates to Guess the List setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("GUESS THE LIST"));
    expect(screen.getByTestId("guess-the-list-setup")).toBeInTheDocument();
  });

  it("opens Guess the List setup on its Solo default from the launcher row", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const row = screen.getByRole("link", { name: /guess the list/i });
    expect(row).toHaveAttribute("href", "/list");
    fireEvent.click(row);
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toBeInTheDocument();
    expect(setup).toHaveAttribute("data-initial-mode", "solo");
    expect(setup).toHaveAttribute("data-initial-online-game-type", "classic");
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

  it("renders a fully clickable Higher or Lower launcher row", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const row = screen.getByRole("link", { name: /higher or lower/i });
    expect(row).toHaveAttribute("href", "/higherlower");
    fireEvent.click(row);
    expect(screen.getByTestId("hl-setup")).toBeInTheDocument();
  });

  it("does not set applyPreferences on a fresh Higher or Lower setup visit", () => {
    render(
      <MemoryRouter initialEntries={["/higherlower"]}>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByTestId("hl-setup")).toHaveAttribute(
      "data-apply-preferences",
      "false"
    );
  });

  it("preserves replay settings: Play Again returns to setup with applyPreferences set", () => {
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: "/higherlower/play", state: { initialState: { id: 1 } } },
        ]}
      >
        <App />
      </MemoryRouter>
    );

    // The board renders from the passed-in game state.
    expect(screen.getByTestId("hl-board")).toBeInTheDocument();

    // Play Again routes back to setup with the replay flag, so the setup screen
    // is told to restore the player's last-used choices.
    fireEvent.click(screen.getByText("Play Again"));
    const setup = screen.getByTestId("hl-setup");
    expect(setup).toBeInTheDocument();
    expect(setup).toHaveAttribute("data-apply-preferences", "true");
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

  it("opens Career Online with a prefilled code from /career?join=", () => {
    render(
      <MemoryRouter initialEntries={["/career?join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("career-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-join-code", "ABC123");
  });

  it("ignores an invalid /career?join= code and falls back to Solo setup", () => {
    render(
      <MemoryRouter initialEntries={["/career?join=bad"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("career-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "solo");
    expect(setup).toHaveAttribute("data-initial-join-code", "");
  });

  it("keeps /career?quick=1 on Quick Match and ignores any invite code", () => {
    render(
      <MemoryRouter initialEntries={["/career?quick=1&join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("career-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-join-code", "");
  });

  it("opens Photo Online with a prefilled code from /photo?join=", () => {
    render(
      <MemoryRouter initialEntries={["/photo?join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("photo-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-join-code", "ABC123");
  });

  it("ignores an invalid /photo?join= code and falls back to Solo setup", () => {
    render(
      <MemoryRouter initialEntries={["/photo?join=bad"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("photo-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "solo");
    expect(setup).toHaveAttribute("data-initial-join-code", "");
  });

  it("keeps /photo?quick=1 on Quick Match and ignores any invite code", () => {
    render(
      <MemoryRouter initialEntries={["/photo?quick=1&join=abc123"]}>
        <App />
      </MemoryRouter>
    );
    const setup = screen.getByTestId("photo-setup");
    expect(setup).toHaveAttribute("data-initial-mode", "online");
    expect(setup).toHaveAttribute("data-initial-join-code", "");
  });
});

describe("HomePage UI variant", () => {
  it("renders the classic home when variant is 'classic'", () => {
    render(<MemoryRouter><HomePage variant="classic" /></MemoryRouter>);
    expect(screen.getByText("TICTACTOE")).toBeInTheDocument();
    expect(screen.queryByText("TIC-TAC-TOE")).not.toBeInTheDocument();
    expect(screen.queryByText("★ Most played")).not.toBeInTheDocument();
  });

  it("renders the refined home when variant is 'refined'", () => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);
    expect(screen.getByText("TIC-TAC-TOE")).toBeInTheDocument();
    expect(screen.getByText("Tap a game to start.")).toBeInTheDocument();
    expect(screen.queryByText("TICTACTOE")).not.toBeInTheDocument();
  });

  it("uses the game-first launcher without depending on viewport detection", () => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: /choose your game/i })).toBeInTheDocument();
    expect(screen.queryByText(/how well do you know/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Name a player who fits both clues")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /tic-tac-toe/i })).toHaveAttribute("href", "/tictactoe");
    expect(screen.getByText("★ Most played")).toBeInTheDocument();
  });

  it("renders every game and the launcher heading in both variants", () => {
    for (const variant of ["classic", "refined"]) {
      const { unmount } = render(
        <MemoryRouter><HomePage variant={variant} /></MemoryRouter>
      );
      if (variant === "refined") {
        expect(screen.getByRole("heading", { name: /choose your game/i })).toBeInTheDocument();
      } else {
        expect(screen.getByText(/choose your game/i)).toBeInTheDocument();
      }
      expect(screen.getByText("GUESS THE LIST")).toBeInTheDocument();
      expect(screen.getByText("HIGHER OR LOWER")).toBeInTheDocument();
      expect(screen.getByText("CAREER QUIZ")).toBeInTheDocument();
      expect(screen.getByText("PHOTO QUIZ")).toBeInTheDocument();
      unmount();
    }
  });

  it("keeps marketing prose out of the refined launcher", () => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);
    expect(screen.queryByText(/how well do you know/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/five ways to test/i)).not.toBeInTheDocument();
  });
});

describe("Universal refined game launcher", () => {
  const gameRows = [
    [/tic-tac-toe/i, "/tictactoe"],
    [/guess the list/i, "/list"],
    [/higher or lower/i, "/higherlower"],
    [/career quiz/i, "/career"],
    [/photo quiz/i, "/photo"],
  ];

  it.each(gameRows)("makes the full %s row navigate to %s", (name, href) => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  });

  it("gives every game row tactile press feedback without delaying navigation", () => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);
    const links = screen.getByRole("navigation", { name: "EuroLeague quiz games" })
      .querySelectorAll("a");

    expect(links).toHaveLength(5);
    links.forEach((link) => {
      expect(link).toHaveClass("home-game-row", "focus-visible:ring-elq-cta");
      expect(link).not.toHaveClass("focus-visible:ring-elq-orange");
    });
  });

  it("keeps TicTacToe visually dominant without adding a second nested link", () => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);
    const featured = screen.getByRole("link", { name: /most played.*tic-tac-toe.*play/i });
    expect(within(featured).getByText("★ Most played")).toHaveClass("text-elq-cta");
    expect(within(featured).getByText("PLAY")).toHaveClass("bg-elq-cta");
    expect(featured.querySelectorAll("a")).toHaveLength(0);
  });

  it("opens Career Quiz setup on its Solo default from the launcher row", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByRole("link", { name: /career quiz/i }));
    expect(screen.getByTestId("career-setup")).toHaveAttribute("data-initial-mode", "solo");
  });
});

describe("Refined launcher mode guidance", () => {
  const renderRefined = () =>
    render(
      <MemoryRouter>
        <HomePage variant="refined" />
      </MemoryRouter>
    );

  it("labels every row with its available modes", () => {
    renderRefined();
    expect(screen.getAllByText("Solo · Local · Online")).toHaveLength(2);
    expect(screen.getAllByText("Solo · Online")).toHaveLength(2);
  });

  it("labels Higher or Lower as Solo-only", () => {
    renderRefined();
    const row = screen.getByRole("link", { name: /higher or lower/i });
    expect(within(row).getByText("Solo")).toBeInTheDocument();
  });

  it("keeps the Most played accolade distinct from the mode label", () => {
    renderRefined();
    const featured = screen.getByRole("link", { name: /most played.*tic-tac-toe/i });
    expect(within(featured).getByText("★ Most played")).toHaveClass("text-elq-cta");
    expect(within(featured).getByText("Solo · Local · Online")).toHaveClass("text-elq-muted");
  });

  it("uses one short instruction instead of a mode legend", () => {
    renderRefined();
    expect(screen.getByText("Tap a game to start.")).toBeInTheDocument();
    expect(screen.queryByText(/mode tags show how to play/i)).not.toBeInTheDocument();
  });

  it("does not add refined mode labels to the classic variant", () => {
    render(
      <MemoryRouter>
        <HomePage variant="classic" />
      </MemoryRouter>
    );
    expect(screen.queryByText("Solo · Local · Online")).not.toBeInTheDocument();
  });
});

describe("Refined launcher layout", () => {
  const renderRefined = () =>
    render(
      <MemoryRouter>
        <HomePage variant="refined" />
      </MemoryRouter>
    );

  it("removes the old marketing and decorative flagship surfaces", () => {
    renderRefined();
    expect(screen.queryByTestId("flagship-board")).not.toBeInTheDocument();
    expect(screen.queryByText("+ 84 clubs")).not.toBeInTheDocument();
    expect(screen.queryByText(/quick match pairs/i)).not.toBeInTheDocument();
  });

  it("keeps one narrow launcher column at every viewport", () => {
    renderRefined();
    const navigation = screen.getByRole("navigation", { name: "EuroLeague quiz games" });
    expect(navigation).toHaveClass("flex", "flex-col");
    expect(navigation.closest("main")).toHaveClass("home-launcher", "max-w-md");
  });
});
