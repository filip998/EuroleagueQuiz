import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("GameSetup", () => {
  const mockOnGameCreated = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders game mode selection with all three modes", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(screen.getByText("Local 1v1")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("renders the start game button", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    expect(screen.getByText("Start Game")).toBeInTheDocument();
  });

  it("shows player 2 input when local 1v1 is selected", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    // Initially in solo mode — no Player 2 field
    expect(screen.queryByPlaceholderText("Player 2")).not.toBeInTheDocument();

    // Switch to local 1v1
    fireEvent.click(screen.getByText("Local 1v1"));
    expect(screen.getByPlaceholderText("Player 2")).toBeInTheDocument();
  });

  it("defaults Online to the Quick Match preset picker", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Online"));

    expect(screen.getByText("Quick Match")).toBeInTheDocument();
    expect(screen.getByText("Play a Friend")).toBeInTheDocument();
    expect(screen.getByText("Blitz")).toBeInTheDocument();
    expect(screen.getByText("Standard")).toBeInTheDocument();
    expect(screen.getByText("Long")).toBeInTheDocument();
    expect(screen.getByText("Find Match")).toBeInTheDocument();
  });

  it("shows live presence counts on each preset", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Online"));

    expect(screen.getByTestId("presence-blitz")).toHaveTextContent(
      "1 searching · 0 in progress"
    );
    expect(screen.getByTestId("presence-standard")).toHaveTextContent(
      "2 searching · 1 in progress"
    );
  });

  it("finds a quick match and hands back the inferred seat (waiting -> player 1)", async () => {
    quickMatchTicTacToe.mockResolvedValue({
      state: { id: 99, status: "waiting_for_opponent" },
    });

    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Online"));
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "Ace" },
    });
    fireEvent.click(screen.getByText("Find Match"));

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

  it("uses the chosen preset and seats player 2 when matched immediately", async () => {
    quickMatchTicTacToe.mockResolvedValue({
      state: { id: 100, status: "active" },
    });

    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Online"));
    fireEvent.click(screen.getByText("Blitz"));
    fireEvent.click(screen.getByText("Find Match"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(quickMatchTicTacToe).toHaveBeenCalledWith(
      expect.objectContaining({ preset: "blitz" })
    );
    expect(mockOnGameCreated).toHaveBeenCalledWith(
      { state: { id: 100, status: "active" } },
      { playerNumber: 2, isOnline: true }
    );
  });

  it("shows the Create Online Game button under Play a Friend", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Online"));
    fireEvent.click(screen.getByText("Play a Friend"));
    expect(screen.getByText("Create Online Game")).toBeInTheDocument();
  });

  it("shows join code input when Online -> Play a Friend -> Join is selected", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Online"));
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Join"));
    expect(screen.getByPlaceholderText("ABC123")).toBeInTheDocument();
    expect(screen.getByText("Join Game")).toBeInTheDocument();
  });

  it("shows timer and target wins settings for multiplayer modes", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);

    // Solo mode — no timer/target wins selects
    expect(screen.queryByText("First to")).not.toBeInTheDocument();

    // Switch to local 1v1
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

  it("ignores an invalid initialJoinCode and starts in solo mode", () => {
    render(
      <GameSetup
        onGameCreated={mockOnGameCreated}
        onBack={mockOnBack}
        initialJoinCode="bad"
      />
    );

    expect(screen.getByText("Start Game")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("ABC123")).not.toBeInTheDocument();
  });
});
