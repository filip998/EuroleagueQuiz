import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RosterGuessSetup from "../RosterGuessSetup";
import {
  createRosterGame,
  createRosterRaceGame,
  joinRosterRaceGame,
  quickMatchRosterRace,
} from "../api";

vi.mock("../api", () => ({
  createRosterGame: vi.fn(),
  createRosterRaceGame: vi.fn(),
  joinRosterGame: vi.fn(),
  joinRosterRaceGame: vi.fn(),
  quickMatchRosterRace: vi.fn(),
  getRosterRaceQuickMatchPools: vi.fn(),
}));

vi.mock("../identity", () => ({
  getNickname: () => "Ace",
  getDisplayName: () => "Ace",
  setNickname: vi.fn(),
  NICKNAME_MAX_LENGTH: 30,
}));

vi.mock("../rosterRaceQuickMatch", async () => {
  const actual = await vi.importActual("../rosterRaceQuickMatch");
  return {
    ...actual,
    useRosterRaceQuickMatchPools: () => ({
      pools: {
        "modern-standard": { searching: 2, in_progress: 1 },
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

describe("RosterGuessSetup", () => {
  const onGameCreated = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderSetup(props = {}) {
    return render(
      <RosterGuessSetup
        onGameCreated={onGameCreated}
        onBack={onBack}
        {...props}
      />
    );
  }

  it("keeps Solo, Local and Online as the top-level modes", () => {
    renderSetup();

    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(screen.getByText("Local 1v1")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("preserves Classic online create flow", async () => {
    createRosterGame.mockResolvedValue({ state: { id: 10, status: "waiting_for_opponent" } });

    renderSetup();
    fireEvent.click(screen.getByText("Online"));
    fireEvent.click(screen.getByText("Create Online Game"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(createRosterGame).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "online_friend",
        target_wins: 3,
        timer_mode: "40s",
        player1_name: "Ace",
      })
    );
    expect(onGameCreated).toHaveBeenCalledWith(
      { state: { id: 10, status: "waiting_for_opponent" } },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("shows Race quick-match pools inside Online and starts a public race", async () => {
    quickMatchRosterRace.mockResolvedValue({
      state: { id: 20, status: "waiting_for_opponent" },
    });

    renderSetup({ initialMode: "online", initialOnlineGameType: "race" });
    expect(screen.getByText("Classic")).toBeInTheDocument();
    expect(screen.getByText("Race")).toBeInTheDocument();
    expect(screen.getByText("Pick a pool")).toBeInTheDocument();
    expect(screen.getByTestId("presence-modern-standard")).toHaveTextContent(
      "2 searching · 1 in progress"
    );

    fireEvent.click(screen.getByTestId("quick-pick-modern-standard"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(quickMatchRosterRace).toHaveBeenCalledWith({
      preset: "modern-standard",
      player_name: "Ace",
    });
    expect(onGameCreated).toHaveBeenCalledWith(
      { id: 20, status: "waiting_for_opponent" },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("creates a private Race friend game", async () => {
    createRosterRaceGame.mockResolvedValue({ state: { id: 21, status: "waiting_for_opponent" } });

    renderSetup({ initialMode: "online", initialOnlineGameType: "race" });
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Create Online Game"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(createRosterRaceGame).toHaveBeenCalledWith(
      expect.objectContaining({
        target_wins: 2,
        player1_name: "Ace",
        season_range_start: 2000,
        season_range_end: 2025,
      })
    );
    expect(onGameCreated).toHaveBeenCalledWith(
      { state: { id: 21, status: "waiting_for_opponent" } },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("joins a private Race friend game by code", async () => {
    joinRosterRaceGame.mockResolvedValue({ state: { id: 22, status: "active" } });

    renderSetup({ initialMode: "online", initialOnlineGameType: "race" });
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Join"));
    fireEvent.change(screen.getByPlaceholderText("ABC123"), {
      target: { value: "race42" },
    });
    fireEvent.click(screen.getByText("Join Game"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(joinRosterRaceGame).toHaveBeenCalledWith("RACE42", "Ace");
    expect(onGameCreated).toHaveBeenCalledWith(
      { state: { id: 22, status: "active" } },
      { playerNumber: 2, isOnline: true, gameId: 22 }
    );
  });
});
