import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GuessTheListSetup from "../GuessTheListSetup";
import {
  createGuessTheListGame,
  createGuessTheListRaceGame,
  joinGuessTheListRaceGame,
  quickMatchGuessTheListRace,
} from "../api";

const resolveQuickMatchSeatMock = vi.hoisted(() =>
  vi.fn((key, status) => (status === "active" ? 2 : 1))
);

vi.mock("../api", () => ({
  createGuessTheListGame: vi.fn(),
  createGuessTheListRaceGame: vi.fn(),
  joinGuessTheListGame: vi.fn(),
  joinGuessTheListRaceGame: vi.fn(),
  quickMatchGuessTheListRace: vi.fn(),
  getGuessTheListRaceQuickMatchPools: vi.fn(),
}));

vi.mock("../identity", () => ({
  getNickname: () => "Ace",
  getDisplayName: () => "Ace",
  setNickname: vi.fn(),
  NICKNAME_MAX_LENGTH: 30,
}));

vi.mock("../guessTheListRaceQuickMatch", async () => {
  const actual = await vi.importActual("../guessTheListRaceQuickMatch");
  return {
    ...actual,
    useGuessTheListRaceQuickMatchPools: () => ({
      pools: {
        standard: { searching: 2, in_progress: 1 },
      },
      error: false,
    }),
  };
});

vi.mock("../quickMatchSeats", () => ({
  resolveQuickMatchSeat: resolveQuickMatchSeatMock,
}));

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => <button onClick={onClick}>Home</button>,
}));

describe("GuessTheListSetup", () => {
  const onGameCreated = vi.fn();
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderSetup(props = {}) {
    return render(
      <GuessTheListSetup
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
    createGuessTheListGame.mockResolvedValue({ state: { id: 10, status: "waiting_for_opponent" } });

    renderSetup();
    fireEvent.click(screen.getByText("Online"));
    fireEvent.click(screen.getByText("Create Online Game"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(createGuessTheListGame).toHaveBeenCalledWith(
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
    quickMatchGuessTheListRace.mockResolvedValue({
      state: { id: 20, status: "waiting_for_opponent" },
    });

    renderSetup({ initialMode: "online", initialOnlineGameType: "race" });
    expect(screen.getByText("Classic")).toBeInTheDocument();
    expect(screen.getByText("Race")).toBeInTheDocument();
    expect(screen.getByText("Pick a pool")).toBeInTheDocument();
    expect(screen.getByTestId("presence-standard")).toHaveTextContent(
      "2 searching · 1 in progress"
    );

    fireEvent.click(screen.getByTestId("quick-pick-standard"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(quickMatchGuessTheListRace).toHaveBeenCalledWith({
      preset: "standard",
      player_name: "Ace",
    });
    expect(onGameCreated).toHaveBeenCalledWith(
      { id: 20, status: "waiting_for_opponent" },
      { playerNumber: 1, isOnline: true }
    );
    expect(resolveQuickMatchSeatMock).toHaveBeenCalledWith(
      "guess-the-list-race:20",
      "waiting_for_opponent",
      ["roster-race:20"]
    );
  });

  it("creates a private Race friend game", async () => {
    createGuessTheListRaceGame.mockResolvedValue({ state: { id: 21, status: "waiting_for_opponent" } });

    renderSetup({ initialMode: "online", initialOnlineGameType: "race" });
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Create Online Game"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(createGuessTheListRaceGame).toHaveBeenCalledWith(
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

  it("captions Classic create options with Season Range and Settings sections", () => {
    renderSetup();
    fireEvent.click(screen.getByText("Online"));

    // Classic create is the default online sub-mode.
    expect(screen.getByText("Season Range")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("captions Race friend create options with Season Range and Race length sections", () => {
    renderSetup({ initialMode: "online", initialOnlineGameType: "race" });
    fireEvent.click(screen.getByText("Play a Friend"));

    expect(screen.getByText("Season Range")).toBeInTheDocument();
    expect(screen.getByText("Race length")).toBeInTheDocument();
  });

  it("joins a private Race friend game by code", async () => {
    joinGuessTheListRaceGame.mockResolvedValue({ state: { id: 22, status: "active" } });

    renderSetup({ initialMode: "online", initialOnlineGameType: "race" });
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Join"));
    fireEvent.change(screen.getByPlaceholderText("ABC123"), {
      target: { value: "race42" },
    });
    fireEvent.click(screen.getByText("Join Game"));

    await waitFor(() => expect(onGameCreated).toHaveBeenCalled());
    expect(joinGuessTheListRaceGame).toHaveBeenCalledWith("RACE42", "Ace");
    expect(onGameCreated).toHaveBeenCalledWith(
      { state: { id: 22, status: "active" } },
      { playerNumber: 2, isOnline: true, gameId: 22 }
    );
  });
});
