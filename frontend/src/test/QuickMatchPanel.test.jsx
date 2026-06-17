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

  it("badges and highlights the default preset", () => {
    render(
      <QuickMatchPanel
        presets={PRESETS}
        pools={POOLS}
        onPick={vi.fn()}
        defaultPreset="standard"
      />
    );

    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("disables every card and shows Searching… on the pending preset", () => {
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
