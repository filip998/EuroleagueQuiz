import { useRef, useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TicTacToeGuide, { HowToPlayControl } from "../TicTacToeGuide";

const AXIS_TYPES = [
  "team",
  "nationality",
  "played_with",
  "season",
  "position",
  "champion",
  "stat_milestone",
];

describe("TicTacToeGuide", () => {
  it("shows the concise objective with one Help entry point", () => {
    render(<TicTacToeGuide />);

    expect(screen.getByTestId("ttt-objective")).toHaveTextContent(
      "Pick a cell, then name a player who matches both clues."
    );
    expect(screen.getAllByTestId("ttt-help-trigger")).toHaveLength(1);
    expect(screen.queryByTestId("ttt-howto")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ttt-legend-trigger")).not.toBeInTheDocument();
  });

  it("opens one modal Help surface on the How to play tab", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);

    await user.click(screen.getByTestId("ttt-help-trigger"));

    const dialog = screen.getByTestId("ttt-help-dialog");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("tab", { name: "How to play" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(within(dialog).getByRole("tabpanel")).toHaveTextContent(
      "Match one player to both the row and column clue."
    );
  });

  it("explains the game in three compact steps", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);
    await user.click(screen.getByTestId("ttt-help-trigger"));

    const panel = screen.getByTestId("ttt-help-howto-panel");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    expect(panel).toHaveTextContent("Pick an empty cell");
    expect(panel).toHaveTextContent("Choose a matching player");
    expect(panel).toHaveTextContent("Make three in a row");
  });

  it("switches to Clue types and explains every backend axis type", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);
    await user.click(screen.getByTestId("ttt-help-trigger"));
    await user.click(screen.getByRole("tab", { name: "Clue types" }));

    const panel = screen.getByTestId("ttt-help-legend-panel");
    for (const type of AXIS_TYPES) {
      expect(within(panel).getByTestId(`ttt-legend-entry-${type}`)).toBeInTheDocument();
    }
    expect(panel).toHaveTextContent("Played for this club.");
    expect(panel).toHaveTextContent("Shared a roster with this player.");
    expect(panel).toHaveTextContent("Reached the number shown.");
  });

  it("supports arrow, Home, and End navigation across the Help tabs", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);
    await user.click(screen.getByTestId("ttt-help-trigger"));

    const howToTab = screen.getByRole("tab", { name: "How to play" });
    const clueTab = screen.getByRole("tab", { name: "Clue types" });
    howToTab.focus();

    await user.keyboard("{ArrowRight}");
    expect(clueTab).toHaveFocus();
    expect(clueTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(howToTab).toHaveFocus();
    expect(howToTab).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(clueTab).toHaveFocus();
    expect(clueTab).toHaveAttribute("aria-selected", "true");
  });

  it("closes on Escape and restores focus to the Help button", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);

    const trigger = screen.getByTestId("ttt-help-trigger");
    await user.click(trigger);
    expect(screen.getByTestId("ttt-help-dialog")).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");

    expect(screen.queryByTestId("ttt-help-dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(trigger).toHaveFocus();
  });

  it("traps focus inside the dialog", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);
    await user.click(screen.getByTestId("ttt-help-trigger"));

    const dialog = screen.getByTestId("ttt-help-dialog");
    await user.tab();
    expect(dialog).toContainElement(document.activeElement);
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement);
  });

  it("closes from the backdrop and Close button", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);
    await user.click(screen.getByTestId("ttt-help-trigger"));
    fireEvent.click(screen.getByTestId("ttt-help-dialog").parentElement);
    expect(screen.queryByTestId("ttt-help-dialog")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("ttt-help-trigger"));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("ttt-help-dialog")).not.toBeInTheDocument();
  });

  it("portals the dialog outside the board subtree", async () => {
    const user = userEvent.setup();
    const { container } = render(<TicTacToeGuide />);
    await user.click(screen.getByTestId("ttt-help-trigger"));

    const dialog = screen.getByTestId("ttt-help-dialog");
    expect(container).not.toContainElement(dialog);
    expect(document.body).toContainElement(dialog);
  });
});

describe("HowToPlayControl", () => {
  it("opens the same combined Help surface from the desktop command rail", async () => {
    const user = userEvent.setup();
    render(<HowToPlayControl />);

    await user.click(screen.getByTestId("ttt-help-trigger"));

    expect(screen.getByTestId("ttt-help-dialog")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Clue types" })).toBeInTheDocument();
  });
});

describe("Help fallback when the trigger and dialog disconnect together", () => {
  // Mirrors how GameBoard actually hosts these: a stable board-region
  // fallback ref, plus a host that can swap or remove the Help
  // trigger/dialog subtree entirely -- e.g. an ambient/remote event (the
  // opponent finishing the match) replacing the whole layout branch, or a
  // responsive Solo desktop <-> mobile branch swap between HowToPlayControl
  // and TicTacToeGuide. In both cases the trigger button and its HelpDialog
  // unmount in the very same update, so there is no "disabled opener" to
  // fall back from -- only the caller-supplied fallback can save focus from
  // landing on <body>.
  function HelpHostHarness() {
    const [mode, setMode] = useState("guide");
    const fallbackRef = useRef(null);
    return (
      <>
        <div ref={fallbackRef} tabIndex={-1} aria-label="Board region" />
        <button type="button" onClick={() => setMode("none")}>
          Ambient finish
        </button>
        <button type="button" onClick={() => setMode("control")}>
          Swap layout
        </button>
        {mode === "guide" && <TicTacToeGuide fallbackFocusRef={fallbackRef} />}
        {mode === "control" && <HowToPlayControl fallbackFocusRef={fallbackRef} />}
      </>
    );
  }

  it("falls back to the board region (not <body>) when an ambient/remote event removes the Help host entirely while it's open", async () => {
    const user = userEvent.setup();
    render(<HelpHostHarness />);

    await user.click(screen.getByTestId("ttt-help-trigger"));
    expect(screen.getByTestId("ttt-help-dialog")).toBeInTheDocument();

    await user.click(screen.getByText("Ambient finish"));

    expect(screen.queryByTestId("ttt-help-dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Board region")).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("falls back to the board region when a responsive branch swap replaces the Help host (Solo desktop <-> mobile)", async () => {
    const user = userEvent.setup();
    render(<HelpHostHarness />);

    await user.click(screen.getByTestId("ttt-help-trigger"));
    expect(screen.getByTestId("ttt-help-dialog")).toBeInTheDocument();

    await user.click(screen.getByText("Swap layout"));

    expect(screen.queryByTestId("ttt-help-dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Board region")).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });
});
