import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlayerSearch from "../PlayerSearch";

vi.mock("../api", () => ({
  autocompletePlayer: vi.fn(),
  autocompleteRosterPlayer: vi.fn(),
}));

import { autocompletePlayer, autocompleteRosterPlayer } from "../api";

describe("PlayerSearch", () => {
  const mockOnSelect = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    autocompletePlayer.mockResolvedValue({ players: [] });
    autocompleteRosterPlayer.mockResolvedValue({ players: [] });
  });

  it("renders the search modal with input", () => {
    render(
      <PlayerSearch
        rowTeamCode="BAR"
        colTeamCode="RMB"
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText("SEARCH PLAYER")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type player name...")).toBeInTheDocument();
  });

  it("shows team codes in description for non-roster mode", () => {
    render(
      <PlayerSearch
        rowTeamCode="BAR"
        colTeamCode="RMB"
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText("BAR")).toBeInTheDocument();
    expect(screen.getByText("RMB")).toBeInTheDocument();
  });

  it("shows roster mode description when rosterMode is true", () => {
    render(
      <PlayerSearch
        rowTeamCode="BAR"
        colTeamCode="RMB"
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
        rosterMode={true}
      />
    );

    expect(
      screen.getByText("Search for a player you think was on this roster")
    ).toBeInTheDocument();
  });

  it("calls onCancel when Escape is pressed", async () => {
    render(
      <PlayerSearch
        rowTeamCode="BAR"
        colTeamCode="RMB"
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("calls onCancel when clicking the backdrop", () => {
    render(
      <PlayerSearch
        rowTeamCode="BAR"
        colTeamCode="RMB"
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    // Click the outer overlay div
    const overlay = screen.getByText("SEARCH PLAYER").closest(".fixed");
    fireEvent.click(overlay);
    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("searches with debounce and shows results", async () => {
    const players = [
      { player_id: 1, full_name: "Luka Doncic" },
      { player_id: 2, full_name: "Luka Samanic" },
    ];
    autocompletePlayer.mockResolvedValue({ players });

    render(
      <PlayerSearch
        rowTeamCode="BAR"
        colTeamCode="RMB"
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await userEvent.type(input, "luka");

    await waitFor(() => {
      expect(screen.getByText("Luka Doncic")).toBeInTheDocument();
      expect(screen.getByText("Luka Samanic")).toBeInTheDocument();
    });
  });

  it("calls onSelect when clicking a player result", async () => {
    const player = { player_id: 1, full_name: "Luka Doncic" };
    autocompletePlayer.mockResolvedValue({ players: [player] });

    render(
      <PlayerSearch
        rowTeamCode="BAR"
        colTeamCode="RMB"
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await userEvent.type(input, "luka");

    await waitFor(() => {
      expect(screen.getByText("Luka Doncic")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Luka Doncic"));
    expect(mockOnSelect).toHaveBeenCalledWith(player);
  });

  it("shows 'No players found' when query returns empty", async () => {
    autocompletePlayer.mockResolvedValue({ players: [] });

    render(
      <PlayerSearch
        rowTeamCode="BAR"
        colTeamCode="RMB"
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await userEvent.type(input, "zzzzz");

    await waitFor(() => {
      expect(screen.getByText("No players found")).toBeInTheDocument();
    });
  });

  it("uses autocompleteRosterPlayer in roster mode", async () => {
    autocompleteRosterPlayer.mockResolvedValue({
      players: [{ player_id: 3, full_name: "Nikola Mirotic" }],
    });

    render(
      <PlayerSearch
        rowTeamCode="BAR"
        colTeamCode="RMB"
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
        rosterMode={true}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await userEvent.type(input, "mirotic");

    await waitFor(() => {
      expect(autocompleteRosterPlayer).toHaveBeenCalled();
      expect(screen.getByText("Nikola Mirotic")).toBeInTheDocument();
    });
  });
});
