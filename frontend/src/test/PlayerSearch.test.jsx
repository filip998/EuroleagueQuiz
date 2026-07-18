import { useRef, useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
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

function PickerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open picker
      </button>
      {open && (
        <PlayerSearch
          rowAxis={barca}
          colAxis={madrid}
          onSelect={() => {}}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

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

    expect(screen.getByRole("dialog", { name: "Choose a player" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search EuroLeague players" })).toHaveFocus();
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
    expect(screen.getByLabelText(/played for both/i)).toBeInTheDocument();
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
    expect(screen.getByLabelText(/played for.*is from/i)).toBeInTheDocument();
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
    const overlay = screen.getByRole("dialog", { name: "Choose a player" }).parentElement;
    fireEvent.click(overlay);
    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("traps focus, locks background scrolling, and restores the opener", async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);

    const opener = screen.getByRole("button", { name: "Open picker" });
    await user.click(opener);
    expect(document.body.style.overflow).toBe("hidden");

    const input = screen.getByRole("combobox", { name: "Search EuroLeague players" });
    expect(input).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(input).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
  });

  it("restores focus to an explicit triggerRef even when the browser left <body> focused on open (Safari/Firefox pointer behavior)", async () => {
    // Safari and Firefox on macOS commonly do NOT move focus to a plain
    // clicked button, unlike Chromium/jsdom's default userEvent behavior --
    // simulate that by blurring the opener synchronously as part of the same
    // click that opens the picker, so document.activeElement is <body> by
    // the time PlayerSearch's dialog-focus effect runs.
    function PickerHarnessWithTrigger() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef(null);
      return (
        <>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => {
              setOpen(true);
              triggerRef.current?.blur();
            }}
          >
            Open picker
          </button>
          {open && (
            <PlayerSearch
              rowAxis={barca}
              colAxis={madrid}
              onSelect={() => {}}
              onCancel={() => setOpen(false)}
              triggerRef={triggerRef}
            />
          )}
        </>
      );
    }

    const user = userEvent.setup();
    render(<PickerHarnessWithTrigger />);

    const opener = screen.getByRole("button", { name: "Open picker" });
    await user.click(opener);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The explicit triggerRef is deterministic regardless of what (if
    // anything) document.activeElement was when the dialog opened.
    expect(opener).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("falls back to the caller-supplied fallback (not <body>) when no explicit trigger is supplied and the browser left <body> focused on open", async () => {
    function PickerHarnessBodyOpenerNoTrigger() {
      const [open, setOpen] = useState(false);
      const openerRef = useRef(null);
      const fallbackRef = useRef(null);
      return (
        <>
          <button
            ref={openerRef}
            type="button"
            onClick={() => {
              setOpen(true);
              openerRef.current?.blur();
            }}
          >
            Open picker
          </button>
          <div ref={fallbackRef} tabIndex={-1} aria-label="Fallback region" />
          {open && (
            <PlayerSearch
              rowAxis={barca}
              colAxis={madrid}
              onSelect={() => {}}
              onCancel={() => setOpen(false)}
              fallbackFocusRef={fallbackRef}
            />
          )}
        </>
      );
    }

    const user = userEvent.setup();
    render(<PickerHarnessBodyOpenerNoTrigger />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Without an explicit trigger, the captured "opener" would have been
    // <body> itself -- it must be rejected as a restoration target (never
    // meaningfully focusable) rather than silently "restoring" to it, so
    // the supplied fallback is used instead.
    expect(screen.getByLabelText("Fallback region")).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
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

  it("surfaces search failures instead of presenting them as an empty result", async () => {
    autocompletePlayer.mockRejectedValue(new Error("offline"));

    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    await userEvent.type(screen.getByPlaceholderText("Type player name..."), "luka");

    expect(
      await screen.findByText("Player search is unavailable. Try again.")
    ).toBeInTheDocument();
    expect(screen.queryByText("No players found")).not.toBeInTheDocument();
  });

  it("clears a pending search without leaving the picker stuck loading", async () => {
    let resolveSearch;
    autocompletePlayer.mockImplementation(
      () => new Promise((resolve) => {
        resolveSearch = resolve;
      })
    );
    const user = userEvent.setup();

    render(
      <PlayerSearch
        rowAxis={barca}
        colAxis={madrid}
        onSelect={mockOnSelect}
        onCancel={mockOnCancel}
      />
    );

    const input = screen.getByPlaceholderText("Type player name...");
    await user.type(input, "luka");
    await waitFor(() => expect(autocompletePlayer).toHaveBeenCalled());
    expect(screen.getByText("Searching…")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
    expect(screen.getByText("Start typing to find a player.")).toBeInTheDocument();
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();

    await act(async () => {
      resolveSearch({ players: [{ player_id: 1, full_name: "Luka Doncic" }] });
    });
    expect(screen.queryByText("Luka Doncic")).not.toBeInTheDocument();
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

    const first = screen.getByRole("option", { name: "Luka Doncic" });
    const second = screen.getByRole("option", { name: "Luka Samanic" });
    expect(first).not.toHaveClass("bg-orange-50");

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
      screen.getByRole("option", { name: "Luka Doncic" })
    ).toHaveAttribute("aria-selected", "false");
  });

  it("invalidates stale results immediately on edit so an immediate Enter cannot select the old player", async () => {
    const stalePlayer = { player_id: 1, full_name: "Luka Doncic" };
    autocompletePlayer.mockResolvedValueOnce({ players: [stalePlayer] });

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
      expect(screen.getByText("Luka Doncic")).toBeInTheDocument()
    );

    // Edit the query and press Enter immediately, well inside the 250ms
    // debounce window for the new query -- before any new network response
    // could possibly invalidate the old (now-mismatched) result set.
    fireEvent.change(input, { target: { value: "lukas" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mockOnSelect).not.toHaveBeenCalled();
    // The stale result must disappear from the DOM immediately, not just stop
    // being selectable.
    expect(screen.queryByText("Luka Doncic")).not.toBeInTheDocument();
  });

  it("keeps aria-expanded in sync with the rendered listbox while a new search is mid-debounce", async () => {
    autocompletePlayer.mockResolvedValueOnce({
      players: [{ player_id: 1, full_name: "Luka Doncic" }],
    });

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
      expect(screen.getByText("Luka Doncic")).toBeInTheDocument()
    );
    expect(input).toHaveAttribute("aria-expanded", "true");

    fireEvent.change(input, { target: { value: "lukas" } });

    // The previous result set is invalidated immediately, so the listbox is
    // gone from the DOM at the same moment aria-expanded flips -- the two can
    // never disagree.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
  });
});
