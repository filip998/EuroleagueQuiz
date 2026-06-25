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

  it("renders a calm Play CTA on the Photo Quiz card that opens setup on its Solo default", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const cta = screen
      .getAllByTestId("home-quick-match-cta")
      .find((el) => el.getAttribute("href") === "/photo");
    expect(cta).toBeDefined();
    expect(cta).toHaveTextContent("Play");
    fireEvent.click(cta);
    const setup = screen.getByTestId("photo-setup");
    expect(setup).toBeInTheDocument();
    // Solo default: no forced ?quick=1 → Online.
    expect(setup).toHaveAttribute("data-initial-mode", "solo");
  });

  it("navigates to Guess the List setup when clicking the card", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByText("GUESS THE LIST"));
    expect(screen.getByTestId("guess-the-list-setup")).toBeInTheDocument();
  });

  it("renders a calm Play CTA on the Guess the List card that opens setup on its Solo default", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const cta = screen
      .getAllByTestId("home-quick-match-cta")
      .find((el) => el.getAttribute("href") === "/list");
    expect(cta).toBeDefined();
    expect(cta).toHaveTextContent("Play");
    fireEvent.click(cta);
    const setup = screen.getByTestId("guess-the-list-setup");
    expect(setup).toBeInTheDocument();
    // Solo default: no forced ?quick=1 → Online → Race.
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

  it("renders a persistent low-emphasis Play CTA on the Higher or Lower card that opens setup", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const cta = screen.getByTestId("home-play-cta");
    // Persistent: present in the DOM without any hover interaction...
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute("href", "/higherlower");
    expect(cta).toHaveTextContent("Play");
    // ...rendered as the shared low-emphasis CTA link (accent text, not a filled
    // button), and never the old hover-only reveal.
    expect(cta.className).toContain("text-elq-cta");
    expect(cta.className).not.toContain("bg-elq-cta");
    expect(cta.className).not.toContain("opacity-0");
    expect(cta.className).not.toContain("group-hover:opacity-100");
    fireEvent.click(cta);
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

describe("Refined home action hierarchy (#241)", () => {
  it("keeps the flagship Quick Match as the only filled primary CTA", () => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);
    const flagship = screen
      .getAllByTestId("home-quick-match-cta")
      .find((el) => el.getAttribute("href") === "/tictactoe");
    expect(flagship).toBeDefined();
    expect(flagship).toHaveTextContent("Quick Match");
    // The flagship is the page-level primary action: a solid filled button.
    expect(flagship.className).toContain("bg-elq-cta");
  });

  // Each mini card keeps its existing testid but renders a low-emphasis "Play" link
  // that opens the game's setup on its Solo default (no forced ?quick=1).
  it.each([
    ["/list", "home-quick-match-cta"],
    ["/career", "home-quick-match-cta"],
    ["/photo", "home-quick-match-cta"],
    ["/higherlower", "home-play-cta"],
  ])("renders a low-emphasis Solo-default Play CTA for %s", (href, testid) => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);
    const cta = screen
      .getAllByTestId(testid)
      .find((el) => el.getAttribute("href") === href);
    expect(cta).toBeDefined();
    expect(cta).toHaveTextContent("Play");
    // Quieter than the flagship: accent text link, not a filled button.
    expect(cta.className).toContain("text-elq-cta");
    expect(cta.className).not.toContain("bg-elq-cta");
  });

  it("opens Career Quiz setup on its Solo default from the calm Play CTA", () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    const cta = screen
      .getAllByTestId("home-quick-match-cta")
      .find((el) => el.getAttribute("href") === "/career");
    expect(cta).toBeDefined();
    fireEvent.click(cta);
    const setup = screen.getByTestId("career-setup");
    expect(setup).toBeInTheDocument();
    expect(setup).toHaveAttribute("data-initial-mode", "solo");
  });

  it("replaces the fake 'Solo · 1v1 · Online' pill with a real Solo · Local · Friend link into setup", () => {
    render(<MemoryRouter><HomePage variant="refined" /></MemoryRouter>);
    expect(screen.queryByText("Solo · 1v1 · Online")).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /solo . local . friend/i });
    expect(link).toHaveAttribute("href", "/tictactoe");
    // A text link, not a button/pill — must not carry the filled CTA style.
    expect(link.className).not.toContain("bg-elq-cta");
  });

  it("qualifies Quick Match as online with adjacent helper copy in refined only", () => {
    const { unmount } = render(
      <MemoryRouter><HomePage variant="refined" /></MemoryRouter>
    );
    expect(screen.getByText(/online 1v1/i)).toBeInTheDocument();
    unmount();
    render(<MemoryRouter><HomePage variant="classic" /></MemoryRouter>);
    expect(screen.queryByText(/online 1v1/i)).not.toBeInTheDocument();
  });
});

describe("Refined home tag taxonomy + mode guidance (#243)", () => {
  const renderRefined = () =>
    render(
      <MemoryRouter>
        <HomePage variant="refined" />
      </MemoryRouter>
    );

  it("labels every mini card with one consistent mode/availability tag", () => {
    renderRefined();
    // Guess the List: solo + local + online.
    expect(screen.getByText("Solo · Local · Online")).toBeInTheDocument();
    // Career Quiz and Photo Quiz: solo + online (no local 1v1).
    expect(screen.getAllByText("Solo · Online")).toHaveLength(2);
    // The "Streak" mechanic is no longer a mode tag...
    expect(screen.queryByText("Streak")).not.toBeInTheDocument();
    // ...it stays in Higher or Lower's description instead.
    expect(screen.getByText(/build a streak/i)).toBeInTheDocument();
  });

  it("tags Higher or Lower as Solo-only without colliding with the legend's Solo token", () => {
    renderRefined();
    const holCard = screen.getByText("HIGHER OR LOWER").closest("div.group");
    expect(holCard).not.toBeNull();
    expect(within(holCard).getByText("Solo")).toBeInTheDocument();
  });

  it("keeps the ★ Most played accolade visually distinct from the mode chips", () => {
    renderRefined();
    const accolade = screen.getByText("★ Most played");
    const modeChip = screen.getByText("Solo · Local · Online");
    // Accolade is a soft-filled orange badge; mode chips are muted outlines.
    expect(accolade).toHaveClass("bg-orange-50");
    expect(accolade).toHaveClass("text-elq-cta");
    expect(modeChip).not.toHaveClass("bg-orange-50");
    expect(modeChip).toHaveClass("text-elq-muted");
  });

  it("surfaces the mode legend under the heading and drops the far-right micro-line", () => {
    renderRefined();
    expect(
      screen.queryByText("Jump in solo, pass-and-play, or matchmake online")
    ).not.toBeInTheDocument();
    const legend = screen.getByText(/mode tags show how to play/i);
    expect(legend).toHaveTextContent(/Solo.*Local 1v1.*Online/);
  });

  it("does not leak the #243 legend or mode tags into the classic variant", () => {
    render(
      <MemoryRouter>
        <HomePage variant="classic" />
      </MemoryRouter>
    );
    expect(screen.queryByText(/mode tags show how to play/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Solo · Local · Online")).not.toBeInTheDocument();
  });
});

describe("Refined home flagship board affordance + polish (#242)", () => {
  const renderRefined = () =>
    render(
      <MemoryRouter>
        <HomePage variant="refined" />
      </MemoryRouter>
    );

  it("renders the 3×3 motif as a non-interactive decorative backdrop, not a claimable grid", () => {
    renderRefined();
    const board = screen.getByTestId("flagship-board");
    // Decorative: removed from the a11y tree and non-interactive.
    expect(board).toHaveAttribute("aria-hidden", "true");
    expect(board.className).toContain("pointer-events-none");
    // No live-game signals: no claimable links, and none of the old orange
    // "claimed" cells / coloured ownership tiles remain inside the motif.
    expect(board.querySelector("a")).toBeNull();
    expect(board.querySelector(".bg-elq-cta")).toBeNull();
    expect(board.querySelector(".bg-orange-50")).toBeNull();
  });

  it("omits the decorative flagship board from the classic variant", () => {
    render(
      <MemoryRouter>
        <HomePage variant="classic" />
      </MemoryRouter>
    );
    expect(screen.queryByTestId("flagship-board")).not.toBeInTheDocument();
  });

  it("places the '+ 84 clubs' crest strip ahead of the primary action so they don't compete", () => {
    renderRefined();
    const clubs = screen.getByText("+ 84 clubs");
    const primary = screen
      .getAllByTestId("home-quick-match-cta")
      .find((el) => el.getAttribute("href") === "/tictactoe");
    expect(primary).toBeDefined();
    // crest strip precedes the flagship primary CTA in document order.
    expect(
      clubs.compareDocumentPosition(primary) & clubs.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps the flagship Solo link free of its own top margin (single action-row margin source)", () => {
    renderRefined();
    const solo = screen.getByRole("link", { name: /solo . local . friend/i });
    expect(solo.className).not.toContain("mt-4");
  });

  it("equalises the 2×2 mini-card rows so their CTAs align across rows", () => {
    renderRefined();
    const grid = screen.getByText("GUESS THE LIST").closest("div.group").parentElement;
    expect(grid.className).toContain("auto-rows-fr");
  });
});
