import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlayerSearch from "../PlayerSearch";

vi.mock("../api", () => ({
  autocompletePlayer: vi.fn(),
  autocompleteGuessTheListPlayer: vi.fn(),
}));

import { autocompletePlayer, autocompleteGuessTheListPlayer } from "../api";

const teamAxis = (name, code) => ({
  axis_type: "team",
  value: "1",
  display_label: name,
  team_code: code,
  team_name: name,
});
const natAxis = (name) => ({ axis_type: "nationality", value: name, display_label: name });

const barca = teamAxis("Barcelona", "BAR");
const madrid = teamAxis("Real Madrid", "RMB");

describe("PlayerSearch", () => {
  const mockOnSelect = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    autocompletePlayer.mockResolvedValue({ players: [] });
    autocompleteGuessTheListPlayer.mockResolvedValue({ players: [] });
  });

  it("renders the search modal with input", () => {
    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText("SEARCH PLAYER")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type player name...")).toBeInTheDocument();
  });

  it("shows full club names (not raw codes) for a team-vs-team prompt", () => {
    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText("Barcelona")).toBeInTheDocument();
    expect(screen.getByText("Real Madrid")).toBeInTheDocument();
    // The raw upstream codes must never surface in the prompt.
    expect(screen.queryByText("BAR")).not.toBeInTheDocument();
    expect(screen.queryByText("RMB")).not.toBeInTheDocument();
    expect(screen.getByText(/played for both/)).toBeInTheDocument();
  });

  it("derives a mixed-axis prompt (team x nationality) with no blanks or codes", () => {
    render(
      <PlayerSearch
        rowAxis={madrid}
        colAxis={natAxis("Serbia")}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText("Real Madrid")).toBeInTheDocument();
    expect(screen.getByText("Serbia")).toBeInTheDocument();
    expect(screen.getByText(/played for/)).toBeInTheDocument();
    expect(screen.getByText(/is from/)).toBeInTheDocument();
  });

  it("shows Guess the List description when guessTheListMode is true", () => {
    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
        guessTheListMode={true}
      />
    );

    expect(
      screen.getByText("Search for a player you think was on this roster")
    ).toBeInTheDocument();
  });

  it("calls onCancel when Escape is pressed", async () => {
    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
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
        rowAxis={barca}
        colAxis={madrid}
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
        rowAxis={barca}
        colAxis={madrid}
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

  it("disambiguates duplicate names with a nationality · era context line", async () => {
    const players = [
      {
        player_id: 1,
        full_name: "Vasilije Micic",
        nationality: "Serbia",
        era: "2014\u20132024",
      },
      // A second "Micic" with no context still renders its bare name (no crash).
      { player_id: 2, full_name: "Marko Micic" },
    ];
    autocompletePlayer.mockResolvedValue({ players });

    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await userEvent.type(input, "micic");

    await waitFor(() => {
      expect(screen.getByText("Vasilije Micic")).toBeInTheDocument();
    });
    // The extra context distinguishes the otherwise duplicate surnames.
    expect(screen.getByText("Serbia \u00b7 2014\u20132024")).toBeInTheDocument();
    // The context line is the player's button, so the whole row stays selectable.
    fireEvent.click(screen.getByText("Vasilije Micic"));
    expect(mockOnSelect).toHaveBeenCalledWith(players[0]);
  });

  it("calls onSelect when clicking a player result", async () => {
    const player = { player_id: 1, full_name: "Luka Doncic" };
    autocompletePlayer.mockResolvedValue({ players: [player] });

    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
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

  it("calls onSelect when Enter is pressed with one player result", async () => {
    const player = { player_id: 1, full_name: "Luka Doncic" };
    autocompletePlayer.mockResolvedValue({ players: [player] });

    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await userEvent.type(input, "luka");

    await waitFor(() => {
      expect(screen.getByText("Luka Doncic")).toBeInTheDocument();
    });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOnSelect).toHaveBeenCalledWith(player);
  });

  it("shows 'No players found' when query returns empty", async () => {
    autocompletePlayer.mockResolvedValue({ players: [] });

    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
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

  it("uses autocompleteGuessTheListPlayer in Guess the List mode", async () => {
    autocompleteGuessTheListPlayer.mockResolvedValue({
      players: [{ player_id: 3, full_name: "Nikola Mirotic" }],
    });

    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
        guessTheListMode={true}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await userEvent.type(input, "mirotic");

    await waitFor(() => {
      expect(autocompleteGuessTheListPlayer).toHaveBeenCalled();
      expect(screen.getByText("Nikola Mirotic")).toBeInTheDocument();
    });
  });

  it("moves a highlight with ArrowDown and selects the highlighted player on Enter", async () => {
    const players = [
      { player_id: 1, full_name: "Luka Doncic" },
      { player_id: 2, full_name: "Luka Samanic" },
    ];
    autocompletePlayer.mockResolvedValue({ players });

    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await userEvent.type(input, "luka");
    await waitFor(() =>
      expect(screen.getByText("Luka Samanic")).toBeInTheDocument()
    );

    const first = screen.getByText("Luka Doncic").closest("button");
    const second = screen.getByText("Luka Samanic").closest("button");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockOnSelect).toHaveBeenCalledWith(players[1]);
  });

  it("returns to the input on ArrowUp from the first row so Enter selects nothing", async () => {
    const players = [
      { player_id: 1, full_name: "Luka Doncic" },
      { player_id: 2, full_name: "Luka Samanic" },
    ];
    autocompletePlayer.mockResolvedValue({ players });

    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await userEvent.type(input, "luka");
    await waitFor(() =>
      expect(screen.getByText("Luka Samanic")).toBeInTheDocument()
    );

    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight row 0
    fireEvent.keyDown(input, { key: "ArrowUp" }); // back to the input (-1)
    fireEvent.keyDown(input, { key: "Enter" }); // multiple results, no highlight

    expect(mockOnSelect).not.toHaveBeenCalled();
    expect(
      screen.getByText("Luka Doncic").closest("button")
    ).toHaveAttribute("aria-selected", "false");
  });
});
