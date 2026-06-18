import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

vi.mock("../rosterRaceQuickMatch", async () => {
  const actual = await vi.importActual("../rosterRaceQuickMatch");
  return {
    ...actual,
    useRosterRaceQuickMatchPools: () => ({
      pools: {
        "full-quick": { searching: 1, in_progress: 0 },
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
  LogoMini: ({ onClick }) => (
    <button data-testid="logo-mini" onClick={onClick}>Logo</button>
  ),
  LogoFull: () => <div data-testid="logo-full" />,
  default: () => <div data-testid="logo-full" />,
}));

const originalLocalStorage = globalThis.localStorage;

describe("RosterGuessSetup", () => {
  const mockOnGameCreated = vi.fn();
  const mockOnBack = vi.fn();

  function renderSetup(props = {}) {
    return render(
      <RosterGuessSetup
        onGameCreated={mockOnGameCreated}
        onBack={mockOnBack}
        {...props}
      />
    );
  }

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

  it("starts in solo Classic mode with the original Start Game action", () => {
    renderSetup();
    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(screen.getByText("Start Game")).toBeInTheDocument();
    expect(screen.queryByText("Quick Match")).not.toBeInTheDocument();
  });

  it("starts on Race Quick Match when requested by the route", () => {
    renderSetup({ initialMode: "online", initialGameType: "race" });
    expect(screen.getByText("Quick Match")).toBeInTheDocument();
    expect(screen.getByText("Play a Friend")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-modern-standard")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.queryByText("Create Race Game")).not.toBeInTheDocument();
  });

  it("starts a Race Quick Match and hands back the inferred waiting seat", async () => {
    quickMatchRosterRace.mockResolvedValue({
      state: { id: 42, status: "waiting_for_opponent" },
    });

    renderSetup({ initialMode: "online", initialGameType: "race" });
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "Racer" },
    });
    fireEvent.click(screen.getByTestId("quick-pick-modern-standard"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(quickMatchRosterRace).toHaveBeenCalledWith({
      preset: "modern-standard",
      player_name: "Racer",
    });
    expect(mockOnGameCreated).toHaveBeenCalledWith(
      { id: 42, status: "waiting_for_opponent" },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("creates a private Race friend game", async () => {
    createRosterRaceGame.mockResolvedValue({
      state: { id: 43, status: "waiting_for_opponent" },
    });

    renderSetup({ initialMode: "online", initialGameType: "race" });
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Create Race Game"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(createRosterRaceGame).toHaveBeenCalledWith(
      expect.objectContaining({
        target_wins: 3,
        season_range_start: 2000,
        season_range_end: 2025,
      })
    );
    expect(mockOnGameCreated).toHaveBeenCalledWith(
      { state: { id: 43, status: "waiting_for_opponent" } },
      { playerNumber: 1, isOnline: true }
    );
  });

  it("joins a private Race friend game", async () => {
    joinRosterRaceGame.mockResolvedValue({ state: { id: 44, status: "active" } });

    renderSetup({ initialMode: "online", initialGameType: "race" });
    fireEvent.click(screen.getByText("Play a Friend"));
    fireEvent.click(screen.getByText("Join"));
    fireEvent.change(screen.getByPlaceholderText("Your name"), {
      target: { value: "Racer 2" },
    });
    fireEvent.change(screen.getByPlaceholderText("ABC123"), {
      target: { value: "abc123" },
    });
    fireEvent.click(screen.getByText("Join Game"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(joinRosterRaceGame).toHaveBeenCalledWith("ABC123", "Racer 2");
    expect(mockOnGameCreated).toHaveBeenCalledWith(
      { state: { id: 44, status: "active" } },
      { playerNumber: 2, isOnline: true, gameId: 44 }
    );
  });

  it("keeps Classic online creation on the existing endpoint", async () => {
    createRosterGame.mockResolvedValue({
      state: { id: 45, status: "waiting_for_opponent" },
    });

    renderSetup({ initialMode: "online" });
    fireEvent.click(screen.getByText("Create Online Game"));

    await waitFor(() => expect(mockOnGameCreated).toHaveBeenCalled());
    expect(createRosterGame).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "online_friend",
        target_wins: 3,
        timer_mode: "40s",
      })
    );
    expect(createRosterRaceGame).not.toHaveBeenCalled();
  });
});
