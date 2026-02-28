import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import GameSetup from "../GameSetup";

vi.mock("../api", () => ({
  createGame: vi.fn(),
  joinGame: vi.fn(),
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

  it("shows join game form when clicking 'Join a game'", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Join a game"));
    expect(screen.getByText("JOIN GAME")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("ABC123")).toBeInTheDocument();
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

  it("shows 'Create Online Game' button when online mode selected", () => {
    render(<GameSetup onGameCreated={mockOnGameCreated} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText("Online"));
    expect(screen.getByText("Create Online Game")).toBeInTheDocument();
  });
});
