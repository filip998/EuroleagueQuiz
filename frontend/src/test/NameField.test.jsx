import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import NameField from "../NameField";

describe("NameField", () => {
  it("renders the standardized label, placeholder, and length cap by default", () => {
    render(<NameField value="" onChange={() => {}} />);
    const input = screen.getByLabelText("Your Name");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "Your name");
    expect(input).toHaveAttribute("maxlength", "30");
  });

  it("is optional (never required) so anonymous play keeps working", () => {
    render(<NameField value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Your Name")).not.toBeRequired();
  });

  it("is a controlled field and reports edits as the raw string value", () => {
    const onChange = vi.fn();
    render(<NameField value="Ada" onChange={onChange} />);
    const input = screen.getByLabelText("Your Name");
    expect(input.value).toBe("Ada");
    fireEvent.change(input, { target: { value: "Bob" } });
    expect(onChange).toHaveBeenCalledWith("Bob");
  });

  it("supports the Local 1v1 label/placeholder override", () => {
    render(
      <NameField value="" onChange={() => {}} label="Player 2" placeholder="Player 2" />
    );
    const input = screen.getByLabelText("Player 2");
    expect(input).toHaveAttribute("placeholder", "Player 2");
  });

  it("can be disabled (e.g. while a quick match is being created)", () => {
    render(<NameField value="" onChange={() => {}} disabled />);
    expect(screen.getByLabelText("Your Name")).toBeDisabled();
  });

  it("associates each label with its input via a unique id", () => {
    render(
      <>
        <NameField value="" onChange={() => {}} />
        <NameField value="" onChange={() => {}} label="Player 2" />
      </>
    );
    const first = screen.getByLabelText("Your Name");
    const second = screen.getByLabelText("Player 2");
    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();
    expect(first.id).not.toBe(second.id);
  });

  it("applies an optional wrapper className without affecting the input", () => {
    const { container } = render(
      <NameField value="" onChange={() => {}} className="mb-6" />
    );
    expect(container.firstChild).toHaveClass("mb-6");
  });
});
