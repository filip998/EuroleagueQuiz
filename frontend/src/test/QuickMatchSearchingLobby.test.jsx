import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import QuickMatchSearchingLobby from "../QuickMatchSearchingLobby";

// Stub the polling hook so the lobby renders deterministic presence without
// touching the network or timers. Keep the real label/format helpers.
vi.mock("../quickMatch", async () => {
  const actual = await vi.importActual("../quickMatch");
  return {
    ...actual,
    useQuickMatchPools: () => ({
      pools: { blitz: { searching: 4, in_progress: 2 } },
      error: false,
    }),
  };
});

describe("QuickMatchSearchingLobby", () => {
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the searching headline, preset label and live presence", () => {
    render(<QuickMatchSearchingLobby preset="blitz" onCancel={onCancel} />);

    expect(screen.getByText("SEARCHING THE POOL…")).toBeInTheDocument();
    expect(screen.getByText("Blitz")).toBeInTheDocument();
    expect(screen.getByTestId("searching-presence")).toHaveTextContent(
      "4 searching · 2 in progress"
    );
  });

  it("invokes onCancel when the cancel button is clicked", () => {
    render(<QuickMatchSearchingLobby preset="blitz" onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel search"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a cancelling state and disables the button", () => {
    render(
      <QuickMatchSearchingLobby preset="blitz" onCancel={onCancel} cancelling />
    );
    const button = screen.getByText("Cancelling…");
    expect(button).toBeDisabled();
  });

  it("omits the cancel button when no handler is provided", () => {
    render(<QuickMatchSearchingLobby preset="blitz" />);
    expect(screen.queryByText("Cancel search")).not.toBeInTheDocument();
  });
});
