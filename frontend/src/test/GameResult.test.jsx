import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import GameResult from "../GameResult";

describe("GameResult", () => {
  it("renders the headline, subtitle, and game-specific children", () => {
    render(
      <GameResult title="ALICE WINS!" subtitle="3 - 1">
        <p>Career timeline reveal</p>
      </GameResult>
    );

    expect(screen.getByRole("heading", { name: "ALICE WINS!" })).toBeInTheDocument();
    expect(screen.getByText("3 - 1")).toBeInTheDocument();
    expect(screen.getByText("Career timeline reveal")).toBeInTheDocument();
  });

  it("uses the standardized 'Play Again' and 'Home' labels by default and wires the handlers", () => {
    const onPlayAgain = vi.fn();
    const onHome = vi.fn();
    render(<GameResult title="GAME OVER" onPlayAgain={onPlayAgain} onHome={onHome} />);

    const playAgain = screen.getByText("Play Again");
    const home = screen.getByText("Home");
    fireEvent.click(playAgain);
    fireEvent.click(home);

    expect(onPlayAgain).toHaveBeenCalledTimes(1);
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  it("supports custom action labels", () => {
    render(
      <GameResult
        title="GAME OVER"
        onPlayAgain={() => {}}
        playAgainLabel="Rematch"
        onHome={() => {}}
        homeLabel="Lobby"
      />
    );

    expect(screen.getByText("Rematch")).toBeInTheDocument();
    expect(screen.getByText("Lobby")).toBeInTheDocument();
    expect(screen.queryByText("Play Again")).toBeNull();
  });

  it("omits an action when its handler is not provided", () => {
    render(<GameResult title="GAME OVER" onPlayAgain={() => {}} />);

    expect(screen.getByText("Play Again")).toBeInTheDocument();
    expect(screen.queryByText("Home")).toBeNull();
  });

  it("does not render an empty subtitle paragraph", () => {
    const { container } = render(<GameResult title="GAME OVER" subtitle="" />);

    expect(container.querySelector("p")).toBeNull();
  });
});
