import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BoardHeaderNav from "../BoardHeaderNav";

describe("BoardHeaderNav", () => {
  it("renders a single labelled Home control with an accessible name", () => {
    render(<BoardHeaderNav onHome={() => {}} />);

    const nav = screen.getByRole("button", { name: "Back to home" });
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveTextContent("Home");
    // Must never submit a surrounding form when used inside board chrome.
    expect(nav).toHaveAttribute("type", "button");
  });

  it("calls onHome when clicked", () => {
    const onHome = vi.fn();
    render(<BoardHeaderNav onHome={onHome} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));

    expect(onHome).toHaveBeenCalledTimes(1);
  });
});
