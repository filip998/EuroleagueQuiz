import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import GameModeSelector from "../GameModeSelector";

describe("GameModeSelector", () => {
  it("renders nothing for single-mode games", () => {
    const { container } = render(
      <GameModeSelector modes={["solo"]} mode="solo" onModeChange={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a card per mode", () => {
    render(
      <GameModeSelector
        modes={["solo", "local", "online"]}
        mode="solo"
        onModeChange={() => {}}
        sub="create"
        onSubChange={() => {}}
      />
    );
    expect(screen.getByText("Solo")).toBeInTheDocument();
    expect(screen.getByText("Local 1v1")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("calls onModeChange with the clicked mode key", () => {
    const onModeChange = vi.fn();
    render(
      <GameModeSelector
        modes={["solo", "local", "online"]}
        mode="solo"
        onModeChange={onModeChange}
        sub="create"
        onSubChange={() => {}}
      />
    );
    fireEvent.click(screen.getByText("Local 1v1"));
    expect(onModeChange).toHaveBeenCalledWith("local");
  });

  it("shows the Create/Join sub-toggle only when online is selected", () => {
    const { rerender } = render(
      <GameModeSelector
        modes={["solo", "local", "online"]}
        mode="solo"
        onModeChange={() => {}}
        sub="create"
        onSubChange={() => {}}
      />
    );
    expect(screen.queryByText("Join")).not.toBeInTheDocument();

    rerender(
      <GameModeSelector
        modes={["solo", "local", "online"]}
        mode="online"
        onModeChange={() => {}}
        sub="create"
        onSubChange={() => {}}
      />
    );
    expect(screen.getByText("Create")).toBeInTheDocument();
    expect(screen.getByText("Join")).toBeInTheDocument();
  });

  it("calls onSubChange when a sub-toggle is clicked", () => {
    const onSubChange = vi.fn();
    render(
      <GameModeSelector
        modes={["solo", "online"]}
        mode="online"
        onModeChange={() => {}}
        sub="create"
        onSubChange={onSubChange}
      />
    );
    fireEvent.click(screen.getByText("Join"));
    expect(onSubChange).toHaveBeenCalledWith("join");
  });

  it("marks the active mode card with aria-pressed", () => {
    render(
      <GameModeSelector
        modes={["solo", "online"]}
        mode="online"
        onModeChange={() => {}}
        sub="create"
        onSubChange={() => {}}
      />
    );
    expect(screen.getByText("Online").closest("button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Solo").closest("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("renders custom sub-mode labels supplied via subModes", () => {
    const onSubChange = vi.fn();
    render(
      <GameModeSelector
        modes={["solo", "local", "online"]}
        mode="online"
        onModeChange={() => {}}
        sub="quick"
        onSubChange={onSubChange}
        subModes={[
          ["quick", "Quick Match"],
          ["friend", "Play a Friend"],
        ]}
      />
    );

    expect(screen.getByText("Quick Match")).toBeInTheDocument();
    expect(screen.getByText("Play a Friend")).toBeInTheDocument();
    expect(screen.queryByText("Create")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Play a Friend"));
    expect(onSubChange).toHaveBeenCalledWith("friend");
  });
});
