import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import OnlineScoreboard from "../OnlineScoreboard";

function renderBoard(props = {}) {
  return render(
    <OnlineScoreboard
      ariaLabel="Test scoreboard"
      players={[
        { name: "Alice", score: 2 },
        { name: "Bob", score: 1 },
      ]}
      youPlayerNumber={1}
      roundNumber={1}
      targetWins={3}
      {...props}
    />
  );
}

describe("OnlineScoreboard", () => {
  it("renders names, scores, and round/target pills inside a labeled group", () => {
    renderBoard();
    const board = screen.getByRole("group", { name: "Test scoreboard" });
    expect(within(board).getByText("Alice")).toBeInTheDocument();
    expect(within(board).getByText("Bob")).toBeInTheDocument();
    expect(within(board).getByText("2")).toBeInTheDocument();
    expect(within(board).getByText("1")).toBeInTheDocument();
    expect(within(board).getByText("Round 1")).toBeInTheDocument();
    expect(within(board).getByText("First to 3")).toBeInTheDocument();
  });

  it("colors the self-indicator with the player 1 seat tone (blue)", () => {
    renderBoard({ youPlayerNumber: 1 });
    const pill = screen.getByText("You are Alice").closest("div");
    expect(pill.querySelector(".bg-elq-player1")).toBeTruthy();
    expect(pill.querySelector(".bg-elq-player2")).toBeNull();
  });

  it("colors the self-indicator with the player 2 seat tone (red)", () => {
    renderBoard({ youPlayerNumber: 2 });
    const pill = screen.getByText("You are Bob").closest("div");
    expect(pill.querySelector(".bg-elq-player2")).toBeTruthy();
    expect(pill.querySelector(".bg-elq-player1")).toBeNull();
  });

  it("omits the self-indicator when no seat is provided (local/solo)", () => {
    renderBoard({ youPlayerNumber: null });
    expect(screen.queryByText(/^You are /)).not.toBeInTheDocument();
  });

  it("ignores an out-of-range seat number", () => {
    renderBoard({ youPlayerNumber: 0 });
    expect(screen.queryByText(/^You are /)).not.toBeInTheDocument();
  });

  it("renders an optional per-player subline", () => {
    renderBoard({
      players: [
        { name: "Alice", score: 0, subline: "3 claims this round" },
        { name: "Bob", score: 0, subline: "1 claims this round" },
      ],
    });
    expect(screen.getByText("3 claims this round")).toBeInTheDocument();
    expect(screen.getByText("1 claims this round")).toBeInTheDocument();
  });

  it("shows a center countdown with critical styling when the timer is low", () => {
    const { container } = renderBoard({ timer: { seconds: 4, critical: true } });
    expect(container.querySelector(".animate-timer-critical")).toBeTruthy();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("hides the countdown when the timer has no seconds", () => {
    const { container } = renderBoard({ timer: { seconds: null, critical: true } });
    expect(container.querySelector(".animate-timer-critical")).toBeNull();
  });

  it("renders a center status line", () => {
    renderBoard({ statusText: "Alice's turn" });
    expect(screen.getByText("Alice's turn")).toBeInTheDocument();
  });

  it("highlights only the active player's panel", () => {
    renderBoard({
      players: [
        { name: "Alice", score: 0, active: true },
        { name: "Bob", score: 0, active: false },
      ],
    });
    expect(screen.getByLabelText("Alice score 0").className).toContain("ring-2");
    expect(screen.getByLabelText("Bob score 0").className).not.toContain("ring-2");
  });

  it("falls back to a placeholder round pill when the round is unknown", () => {
    renderBoard({ roundNumber: null, targetWins: null });
    expect(screen.getByText("Round -")).toBeInTheDocument();
    expect(screen.queryByText(/^First to /)).not.toBeInTheDocument();
  });

  it("renders an optional title heading when provided", () => {
    renderBoard({ title: "ONLINE RACE" });
    expect(screen.getByText("ONLINE RACE")).toBeInTheDocument();
  });

  it("omits the title heading when none is provided", () => {
    renderBoard();
    expect(screen.queryByText("ONLINE RACE")).not.toBeInTheDocument();
  });
});
