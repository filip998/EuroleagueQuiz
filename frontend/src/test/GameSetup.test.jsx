import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import GameSetup from "../GameSetup";
import { quickMatchTicTacToe } from "../api";

vi.mock("../api", () => ({
  createGame: vi.fn(),
  joinGame: vi.fn(),
  quickMatchTicTacToe: vi.fn(),
  fetchTicTacToeQuickMatchPools: vi.fn(),
}));

// Keep the real presets/labels but stub the polling hook so setup renders
// deterministic presence counts without touching the network.
vi.mock("../quickMatch", async () => {
  const actual = await vi.importActual("../quickMatch");
  return {
    ...actual,
    useQuickMatchPools: () => ({
      pools: {
        blitz: { searching: 1, in_progress: 0 },
        standard: { searching: 2, in_progress: 1 },
        long: { searching: 0, in_progress: 0 },
      },
      error: false,
    }),
  };
});

// Deterministic seat inference (the seat map itself is covered separately).
vi.mock("../quickMatchSeats", () => ({
  resolveQuickMatchSeat: (id, status) => (status === "active" ? 2 : 1),
}));

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => (
    <button data-testid="logo-mini" onClick={onClick}>Logo</button>
  ),
  LogoFull: () => <div data-testid="logo-full" />,
  default: () => <div data-testid="logo-full" />,
}));

// The Node 25 test runtime ships an inert experimental `localStorage` global
// that shadows jsdom's, so install a working in-memory Storage. This keeps the
// guest-name / nickname prefill deterministic and isolated per test.
const originalLocalStorage = globalThis.localStorage;

describe("GameSetup", () => {
  const mockOnGameCreated = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    const store = new Map();
    globalThis.localStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
      clear: () => store.clear(),
    };
  });

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
  });

  it("renders game mode selection with all three modes", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(screen.getByText("Local 1v1")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("lands on the Online Quick Match pool grid by default", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    // Online -> Quick Match is the default landing: the pool cards are the first
    // content, with Standard flagged as the recommended preset (not pre-selected).
    expect(screen.getByText("Quick Match")).toBeInTheDocument();
    expect(screen.getByText("Play a Friend")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-blitz")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-standard")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-long")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
  });

  it("does not render a submit button in the one-click Quick Match landing", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    expect(screen.queryByText("Find Match")).not.toBeInTheDocument();
    expect(screen.queryByText("Start Game")).not.toBeInTheDocument();
    expect(screen.queryByText("Create Online Game")).not.toBeInTheDocument();
  });

  it("prefills the optional name field with a persisted display name", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    // No saved nickname -> the auto-generated, persisted guest name.
    const field = screen.getByPlaceholderText("Your name");
    expect(field.value).toMatch(/^Guest \d{4}$/);
  });

  it("shows live presence counts on each preset", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    expect(screen.getByTestId("presence-blitz")).toHaveTextContent(
      "1 searching · 0 in progress"
    );
    expect(screen.getByTestId("presence-standard")).toHaveTextContent(
      "2 searching · 1 in progress"
    );
  });

  it("one-click picks the default Standard pool and hands back seat (waiting -> player 1)", async () => {
    quickMatchTicTacToe.mockResolvedValue({
      state: { id: 99, status: "waiting_for_opponent" },
    });

    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "Ace" },
    });
    fireEvent.click(screen.getByTestId("quick-pick-standard"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(quickMatchTicTacToe).toHaveBeenCalledWith({
      preset: "standard",
      player_name: "Ace",
    });
    expect(mockOnGameCreated).toHaveBeenCalledWith(
      { state: { id: 99, status: "waiting_for_opponent" } },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("one-click picks Blitz and seats player 2 when matched immediately", async () => {
    quickMatchTicTacToe.mockResolvedValue({
      state: { id: 100, status: "active" },
    });

    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByTestId("quick-pick-blitz"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(quickMatchTicTacToe).toHaveBeenCalledWith(
      expect.objectContaining({ preset: "blitz" })
    );
    expect(mockOnGameCreated).toHaveBeenCalledWith(
      { state: { id: 100, status: "active" } },
      { playerNumber: 2, isOnline: true }
    );
  });

  it("sends player_name null when the name field is cleared (anonymous play)", async () => {
    quickMatchTicTacToe.mockResolvedValue({
      state: { id: 7, status: "waiting_for_opponent" },
    });

    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("quick-pick-standard"));

    await waitFor(() => expect(quickMatchTicTacToe).toHaveBeenCalled());
    expect(quickMatchTicTacToe).toHaveBeenCalledWith({
      preset: "standard",
      player_name: null,
    });
  });

  it("disables every pool card while a pick is in flight (multi-tap guard)", async () => {
    let resolvePick;
    quickMatchTicTacToe.mockImplementation(
      () => new Promise((resolve) => { resolvePick = resolve; })
    );

    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByTestId("quick-pick-standard"));

    // All cards are frozen so a fast second tap can't open a second waiting game.
    expect(screen.getByTestId("quick-pick-blitz")).toBeDisabled();
    expect(screen.getByTestId("quick-pick-standard")).toBeDisabled();
    expect(screen.getByTestId("quick-pick-long")).toBeDisabled();
    expect(screen.getByTestId("presence-standard")).toHaveTextContent("Searching…");

    fireEvent.click(screen.getByTestId("quick-pick-blitz"));
    fireEvent.click(screen.getByTestId("quick-pick-standard"));
    expect(quickMatchTicTacToe).toHaveBeenCalledTimes(1);

    resolvePick({ state: { id: 5, status: "waiting_for_opponent" } });
    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalledTimes(1));
  });

  it("re-enables the pool grid after a failed pick", async () => {
    quickMatchTicTacToe.mockRejectedValue(new Error("matchmaking is down"));

    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByTestId("quick-pick-standard"));

    await waitFor(() =>
      expect(screen.getByText("matchmaking is down")).toBeInTheDocument()
    );
    expect(screen.getByTestId("quick-pick-standard")).not.toBeDisabled();
    expect(mockOnGameCreated).not.toHaveBeenCalled();
  });

  it("keeps Solo reachable one tap away with a Start Game button", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    fireEvent.click(screen.getByText("Solo"));
    expect(screen.getByText("Start Game")).toBeInTheDocument();
    expect(screen.queryByTestId("quick-pick-standard")).not.toBeInTheDocument();
  });

  it("shows player 2 input when local 1v1 is selected", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    // Default Quick Match landing has no Player 2 field.
    expect(screen.queryByPlaceholderText("Player 2")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Local 1v1"));
    expect(screen.getByPlaceholderText("Player 2")).toBeInTheDocument();
  });

  it("shows the Create Online Game button under Play a Friend", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Play a Friend"));
    expect(screen.getByText("Create Online Game")).toBeInTheDocument();
  });

  it("shows join code input when Online -> Play a Friend -> Join is selected", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Join"));
    expect(screen.getByPlaceholderText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("Join Game")).toBeInTheDocument();
  });

  it("shows timer and target wins settings for multiplayer modes", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    // Default Quick Match landing has no First to / Turn timer selects.
    expect(screen.queryByText("First to")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Local 1v1"));
    expect(screen.getByText("First to")).toBeInTheDocument();
    expect(screen.getByText("Turn timer")).toBeInTheDocument();
  });

  it("prefills Online -> Play a Friend -> Join with a valid initialJoinCode", () => {
    render(
      <GameSetup
        onGameCreated={mockOnGameCreated}
        onBack={mockOnBack}
        initialJoinCode="ABC123"
      />
    );

    expect(screen.getByText("Join Game")).toBeInTheDocument();
    const codeInput = screen.getByPlaceholderText("ABC123");
    expect(codeInput).toHaveValue("ABC123");
    expect(screen.getByText("Join Game")).not.toBeDisabled();
  });

  it("ignores an invalid initialJoinCode and lands on Quick Match", () => {
    render(
      <GameSetup
        onGameCreated={mockOnGameCreated}
        onBack={mockOnBack}
        initialJoinCode="bad"
      />
    );

    expect(screen.getByTestId("quick-pick-standard")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("ABC123")).not.toBeInTheDocument();
    expect(screen.queryByText("Start Game")).not.toBeInTheDocument();
  });
});
