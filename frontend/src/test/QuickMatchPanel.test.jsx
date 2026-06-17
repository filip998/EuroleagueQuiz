import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import QuickMatchPanel from "../QuickMatchPanel";

const PRESETS = [
  { key: "blitz", label: "Blitz", detail: "Best of 3 · 15s turns" },
  { key: "standard", label: "Standard", detail: "Best of 3 · 40s turns" },
  { key: "long", label: "Long", detail: "Best of 5 · 40s turns" },
];

const POOLS = {
  blitz: { searching: 1, in_progress: 0 },
  standard: { searching: 2, in_progress: 1 },
  long: { searching: 0, in_progress: 0 },
};

describe("QuickMatchPanel", () => {
  it("renders one tappable card per preset with presence counts", () => {
    render(<QuickMatchPanel presets={PRESETS} pools={POOLS} onPick={vi.fn()} />);

    expect(screen.getByTestId("quick-pick-blitz")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-standard")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-long")).toBeInTheDocument();
    expect(screen.getByTestId("presence-standard")).toHaveTextContent(
      "2 searching · 1 in progress"
    );
  });

  it("calls onPick with the preset key when a card is tapped", () => {
    const onPick = vi.fn();
    render(<QuickMatchPanel presets={PRESETS} pools={POOLS} onPick={onPick} />);

    fireEvent.click(screen.getByTestId("quick-pick-blitz"));
    expect(onPick).toHaveBeenCalledWith("blitz");
  });

  it("badges the default preset as Recommended without pre-selecting any card", () => {
    render(
      <QuickMatchPanel
        presets={PRESETS}
        pools={POOLS}
        onPick={vi.fn()}
        defaultPreset="standard"
      />
    );

    // The default earns a quiet recommendation hint, not the old "Default" badge.
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();

    // No card looks pre-selected at rest: every card shares the same base styling.
    const def = screen.getByTestId("quick-pick-standard");
    const other = screen.getByTestId("quick-pick-blitz");
    expect(def.className).toBe(other.className);
  });

  it("reveals a Play affordance on each interactive card (hover + keyboard focus parity)", () => {
    render(
      <QuickMatchPanel
        presets={PRESETS}
        pools={POOLS}
        onPick={vi.fn()}
        defaultPreset="standard"
      />
    );

    const play = screen.getByTestId("play-standard");
    expect(play).toBeInTheDocument();
    expect(play).toHaveTextContent("Play");
    // jsdom can't apply hover/focus CSS, so lock the reveal contract: the pill is
    // revealed on hover AND keyboard focus-visible (not hover-only).
    expect(play.className).toContain("group-hover:opacity-100");
    expect(play.className).toContain("group-focus-visible:opacity-100");

    expect(screen.getByTestId("play-blitz")).toBeInTheDocument();
    expect(screen.getByTestId("play-long")).toBeInTheDocument();
  });

  it("disables every card, shows Searching…, and hides Play while a pick is pending", () => {
    render(
      <QuickMatchPanel
        presets={PRESETS}
        pools={POOLS}
        onPick={vi.fn()}
        disabled
        pendingPreset="standard"
      />
    );

    expect(screen.getByTestId("quick-pick-blitz")).toBeDisabled();
    expect(screen.getByTestId("quick-pick-standard")).toBeDisabled();
    expect(screen.getByTestId("quick-pick-long")).toBeDisabled();
    expect(screen.getByTestId("presence-standard")).toHaveTextContent("Searching…");
    expect(screen.getByTestId("quick-pick-standard")).toHaveAttribute(
      "aria-busy",
      "true"
    );

    // The Play affordance never shows while the panel is busy.
    expect(screen.queryByTestId("play-standard")).not.toBeInTheDocument();
    expect(screen.queryByTestId("play-blitz")).not.toBeInTheDocument();
    expect(screen.queryByTestId("play-long")).not.toBeInTheDocument();
  });

  it("does not fire onPick when disabled", () => {
    const onPick = vi.fn();
    render(
      <QuickMatchPanel presets={PRESETS} pools={POOLS} onPick={onPick} disabled />
    );

    fireEvent.click(screen.getByTestId("quick-pick-standard"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("supports a custom presence formatter for non-default pool shapes", () => {
    render(
      <QuickMatchPanel
        presets={PRESETS}
        pools={POOLS}
        onPick={vi.fn()}
        formatPresence={(counts) => `${counts?.searching ?? 0} waiting`}
      />
    );

    expect(screen.getByTestId("presence-standard")).toHaveTextContent("2 waiting");
  });
});
