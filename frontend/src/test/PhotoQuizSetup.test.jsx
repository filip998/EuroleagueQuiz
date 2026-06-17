import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PhotoQuizSetup from "../PhotoQuizSetup";
import {
  createPhotoGame,
  createPhotoSoloRound,
  joinPhotoGame,
  photoQuickMatch,
} from "../api";

vi.mock("../api", () => ({
  createPhotoGame: vi.fn(),
  createPhotoSoloRound: vi.fn(),
  joinPhotoGame: vi.fn(),
  photoQuickMatch: vi.fn(),
  getPhotoQuickMatchPools: vi.fn(),
}));

// Keep the real presets/labels/seat key but stub the polling hook so setup
// renders deterministic presence counts without touching the network.
vi.mock("../photoQuickMatch", async () => {
  const actual = await vi.importActual("../photoQuickMatch");
  return {
    ...actual,
    usePhotoQuickMatchPools: () => ({
      pools: {
        quick: { searching: 1, in_progress: 0 },
        standard: { searching: 2, in_progress: 1 },
        long: { searching: 0, in_progress: 0 },
      },
      error: false,
    }),
  };
});

// Deterministic seat inference (the seat map itself is covered separately).
vi.mock("../quickMatchSeats", () => ({
  resolveQuickMatchSeat: (key, status) => (status === "active" ? 2 : 1),
}));

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => (
    <button data-testid="logo-mini" onClick={onClick}>Logo</button>
  ),
  LogoFull: () => <div data-testid="logo-full" />,
  default: () => <div data-testid="logo-full" />,
}));

describe("PhotoQuizSetup", () => {
  const mockOnSoloRound = vi.fn();
  const mockOnGameCreated = vi.fn();
  const mockOnGameJoined = vi.fn();
  const mockOnBack = vi.fn();

  function renderSetup(props = {}) {
    return render(
      <PhotoQuizSetup
        onSoloRound={mockOnSoloRound}
        onGameCreated={mockOnGameCreated}
        onGameJoined={mockOnGameJoined}
        onBack={mockOnBack}
        {...props}
      />
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Solo and Online modes (no Local 1v1)", () => {
    renderSetup();
    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.queryByText("Local 1v1")).not.toBeInTheDocument();
  });

  it("starts in solo mode with a Start Game button", () => {
    renderSetup();
    expect(screen.getByText("Start Game")).toBeInTheDocument();
    expect(screen.queryByText("Quick Match")).not.toBeInTheDocument();
  });

  it("starts on the Quick Match pool grid when initialMode is 'online'", () => {
    renderSetup({ initialMode: "online" });
    expect(screen.getByText("Find Match")).toBeInTheDocument();
    expect(screen.getByText("First to 1")).toBeInTheDocument();
    expect(screen.queryByText("Start Game")).not.toBeInTheDocument();
  });

  it("starts a solo round on submit", async () => {
    const round = { round_token: "solo-1", image_url: "x" };
    createPhotoSoloRound.mockResolvedValue(round);

    renderSetup();
    fireEvent.click(screen.getByText("Start Game"));

    await waitFor(() => expect(mockOnSoloRound).toHaveBeenCalledWith(round));
    expect(createPhotoSoloRound).toHaveBeenCalledWith([]);
  });

  it("defaults Online to the Quick Match preset picker", () => {
    renderSetup();
    fireEvent.click(screen.getByText("Online"));

    expect(screen.getByText("Quick Match")).toBeInTheDocument();
    expect(screen.getByText("Play a Friend")).toBeInTheDocument();
    expect(screen.getByText("First to 1")).toBeInTheDocument();
    expect(screen.getByText("First to 3")).toBeInTheDocument();
    expect(screen.getByText("First to 5")).toBeInTheDocument();
    expect(screen.getByText("Find Match")).toBeInTheDocument();
  });

  it("shows live presence counts on each preset", () => {
    renderSetup();
    fireEvent.click(screen.getByText("Online"));

    expect(screen.getByTestId("presence-quick")).toHaveTextContent(
      "1 searching · 0 in progress"
    );
    expect(screen.getByTestId("presence-standard")).toHaveTextContent(
      "2 searching · 1 in progress"
    );
  });

  it("finds a quick match and hands back the inferred seat (waiting -> player 1)", async () => {
    photoQuickMatch.mockResolvedValue({
      state: { id: 99, status: "waiting_for_opponent" },
    });

    renderSetup();
    fireEvent.click(screen.getByText("Online"));
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "Ace" },
    });
    fireEvent.click(screen.getByText("Find Match"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(photoQuickMatch).toHaveBeenCalledWith({
      preset: "standard",
      player_name: "Ace",
    });
    expect(mockOnGameCreated).toHaveBeenCalledWith(
      { id: 99, status: "waiting_for_opponent" },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("uses the chosen preset and seats player 2 when matched immediately", async () => {
    photoQuickMatch.mockResolvedValue({
      state: { id: 100, status: "active" },
    });

    renderSetup();
    fireEvent.click(screen.getByText("Online"));
    fireEvent.click(screen.getByText("First to 1"));
    fireEvent.click(screen.getByText("Find Match"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(photoQuickMatch).toHaveBeenCalledWith(
      expect.objectContaining({ preset: "quick" })
    );
    expect(mockOnGameCreated).toHaveBeenCalledWith(
      { id: 100, status: "active" },
      { playerNumber: 2, isOnline: true }
    );
  });

  it("creates a private friend game under Play a Friend", async () => {
    createPhotoGame.mockResolvedValue({ state: { id: 5, status: "waiting_for_opponent" } });

    renderSetup();
    fireEvent.click(screen.getByText("Online"));
    fireEvent.click(screen.getByText("Play a Friend"));
    expect(screen.getByText("Create Online Game")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Create Online Game"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(createPhotoGame).toHaveBeenCalledWith(
      expect.objectContaining({ target_wins: 3, wrong_guess_visibility: "private" })
    );
    expect(mockOnGameCreated).toHaveBeenCalledWith(
      { id: 5, status: "waiting_for_opponent" },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("joins a friend game with a 6-character code", async () => {
    joinPhotoGame.mockResolvedValue({ state: { id: 6, status: "active" } });

    renderSetup();
    fireEvent.click(screen.getByText("Online"));
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Join"));

    const codeInput = screen.getByPlaceholderText("ABC123");
    fireEvent.change(codeInput, { target: { value: "abc123" } });
    fireEvent.click(screen.getByText("Join Game"));

    await waitFor(() => expect(mockOnGameJoined).toHaveBeenCalled());
    expect(joinPhotoGame).toHaveBeenCalledWith("ABC123", expect.any(String));
    expect(mockOnGameJoined).toHaveBeenCalledWith(
      { id: 6, status: "active" },
      { playerNumber: 2, isOnline: true }
    );
  });

  it("does not show the preset picker in solo mode", () => {
    renderSetup();
    expect(screen.queryByText("First to 1")).not.toBeInTheDocument();
    expect(screen.queryByText("Find Match")).not.toBeInTheDocument();
  });
});
