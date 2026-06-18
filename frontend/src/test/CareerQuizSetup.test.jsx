import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CareerQuizSetup from "../CareerQuizSetup";
import {
  careerQuickMatch,
  createCareerGame,
  createCareerSoloRound,
  joinCareerGame,
} from "../api";

vi.mock("../api", () => ({
  careerQuickMatch: vi.fn(),
  createCareerGame: vi.fn(),
  createCareerSoloRound: vi.fn(),
  joinCareerGame: vi.fn(),
  getCareerQuickMatchPools: vi.fn(),
}));

vi.mock("../identity", () => ({
  getNickname: () => "Ace",
  setNickname: vi.fn(),
  NICKNAME_MAX_LENGTH: 30,
}));

vi.mock("../careerQuickMatch", async () => {
  const actual = await vi.importActual("../careerQuickMatch");
  return {
    ...actual,
    useCareerQuickMatchPools: () => ({
      pools: {
        quick: { searching: 1, in_progress: 0 },
        standard: { searching: 2, in_progress: 1 },
        long: { searching: 0, in_progress: 0 },
      },
      error: false,
    }),
  };
});

vi.mock("../quickMatchSeats", () => ({
  resolveQuickMatchSeat: (key, status) => (status === "active" ? 2 : 1),
}));

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => <button onClick={onClick}>Home</button>,
}));

describe("CareerQuizSetup", () => {
  const onSoloRound = vi.fn();
  const onGameCreated = vi.fn();
  const onGameJoined = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderSetup(props = {}) {
    return render(
      <CareerQuizSetup
        onSoloRound={onSoloRound}
        onGameCreated={onGameCreated}
        onGameJoined={onGameJoined}
        onBack={onBack}
        {...props}
      />
    );
  }

  it("starts in solo mode and creates a solo round", async () => {
    const round = { round_token: "solo-1", timeline: [] };
    createCareerSoloRound.mockResolvedValue(round);

    renderSetup();
    expect(screen.getByText("Start Game")).toBeInTheDocument();
    expect(screen.queryByText("First to 3")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Start Game"));

    await waitFor(() => expect(onSoloRound).toHaveBeenCalledWith(round));
    expect(createCareerSoloRound).toHaveBeenCalledWith([]);
  });

  it("opens on Online Quick Match when initialMode is online", () => {
    renderSetup({ initialMode: "online" });

    expect(screen.getByText("Quick Match")).toBeInTheDocument();
    expect(screen.getByText("Play a Friend")).toBeInTheDocument();
    expect(screen.getByText("First to 1")).toBeInTheDocument();
    expect(screen.getByText("First to 3")).toBeInTheDocument();
    expect(screen.getByText("First to 5")).toBeInTheDocument();
    expect(screen.getByTestId("presence-standard")).toHaveTextContent(
      "2 searching · 1 in progress"
    );
    expect(screen.queryByText("Create Online Game")).not.toBeInTheDocument();
  });

  it("starts a quick match with one pool click and returns the inferred seat", async () => {
    careerQuickMatch.mockResolvedValue({
      state: { id: 99, status: "waiting_for_opponent" },
    });

    renderSetup({ initialMode: "online" });
    fireEvent.click(screen.getByTestId("quick-pick-standard"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(careerQuickMatch).toHaveBeenCalledWith({
      preset: "standard",
      player_name: "Ace",
    });
    expect(onGameCreated).toHaveBeenCalledWith(
      { id: 99, status: "waiting_for_opponent" },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("creates a private friend game under Play a Friend", async () => {
    createCareerGame.mockResolvedValue({ state: { id: 5, status: "waiting_for_opponent" } });

    renderSetup({ initialMode: "online" });
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Create Online Game"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(createCareerGame).toHaveBeenCalledWith(
      expect.objectContaining({
        target_wins: 3,
        wrong_guess_visibility: "private",
        player1_name: "Ace",
      })
    );
    expect(onGameCreated).toHaveBeenCalledWith(
      { id: 5, status: "waiting_for_opponent" },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("joins a private friend game with a 6-character code", async () => {
    joinCareerGame.mockResolvedValue({ state: { id: 6, status: "active" } });

    renderSetup({ initialMode: "online" });
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Join"));
    fireEvent.change(screen.getByPlaceholderText("ABC123"), {
      target: { value: "career" },
    });
    fireEvent.click(screen.getByText("Join Game"));

    await waitFor(() => expect(onGameJoined).toHaveBeenCalled());
    expect(joinCareerGame).toHaveBeenCalledWith("CAREER", "Ace");
    expect(onGameJoined).toHaveBeenCalledWith(
      { id: 6, status: "active" },
      { playerNumber: 2, isOnline: true }
    );
  });
});
