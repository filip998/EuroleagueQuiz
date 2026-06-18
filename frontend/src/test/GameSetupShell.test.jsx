import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import GameSetupShell, { SectionCaption } from "../GameSetupShell";

vi.mock("../Logo", () => ({
  LogoMini: ({ onClick }) => (
    <button data-testid="logo-mini" onClick={onClick}>Logo</button>
  ),
  LogoFull: () => <div data-testid="logo-full" />,
  default: () => <div data-testid="logo-full" />,
}));

describe("GameSetupShell", () => {
  it("renders the title, tagline and children", () => {
    render(
      <GameSetupShell title="TICTACTOE" tagline="Claim the grid." onHome={() => {}}>
        <p>Body content</p>
      </GameSetupShell>
    );
    expect(screen.getByText("TICTACTOE")).toBeInTheDocument();
    expect(screen.getByText("Claim the grid.")).toBeInTheDocument();
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });

  it("renders the error slot only when an error is provided", () => {
    const { rerender } = render(
      <GameSetupShell title="X" onHome={() => {}}>
        <p>Body</p>
      </GameSetupShell>
    );
    expect(screen.queryByText("Something broke")).not.toBeInTheDocument();

    rerender(
      <GameSetupShell title="X" onHome={() => {}} error="Something broke">
        <p>Body</p>
      </GameSetupShell>
    );
    expect(screen.getByText("Something broke")).toBeInTheDocument();
  });

  it("renders the optional extra card", () => {
    render(
      <GameSetupShell title="X" onHome={() => {}} extra={<p>Leaderboard</p>}>
        <p>Body</p>
      </GameSetupShell>
    );
    expect(screen.getByText("Leaderboard")).toBeInTheDocument();
  });

  it("invokes onHome when the Home logo is clicked", () => {
    const onHome = vi.fn();
    render(
      <GameSetupShell title="X" onHome={onHome}>
        <p>Body</p>
      </GameSetupShell>
    );
    fireEvent.click(screen.getByTestId("logo-mini"));
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});

describe("SectionCaption", () => {
  it("renders its text so every Create pane shares one caption treatment", () => {
    render(<SectionCaption>Settings</SectionCaption>);
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });
});
