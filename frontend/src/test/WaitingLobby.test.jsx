import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import WaitingLobby from "../WaitingLobby";

describe("WaitingLobby", () => {
  it("renders the join code and auto-start helper text", () => {
    render(<WaitingLobby joinCode="ABC123" onCancel={() => {}} />);
    expect(screen.getByText("WAITING FOR OPPONENT")).toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText(/start automatically/i)).toBeInTheDocument();
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(<WaitingLobby joinCode="ABC123" onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("omits the Cancel control when no onCancel is provided", () => {
    render(<WaitingLobby joinCode="ABC123" />);
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
  });

  it("copies the join code and shows feedback", async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<WaitingLobby joinCode="ABC123" onCancel={() => {}} />);
    fireEvent.click(screen.getByText("Copy code"));
    expect(writeText).toHaveBeenCalledWith("ABC123");
    expect(await screen.findByText("Copied!")).toBeInTheDocument();
  });

  it("renders the invite link and copies it with its own feedback", async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    const inviteUrl = "https://play.example.com/tictactoe?join=ABC123";
    render(<WaitingLobby joinCode="ABC123" inviteUrl={inviteUrl} onCancel={() => {}} />);

    expect(screen.getByText(inviteUrl)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Copy link"));
    expect(writeText).toHaveBeenCalledWith(inviteUrl);
    expect(await screen.findByText("Link copied!")).toBeInTheDocument();
  });

  it("omits the invite link when no inviteUrl is provided", () => {
    render(<WaitingLobby joinCode="ABC123" onCancel={() => {}} />);
    expect(screen.queryByText("Copy link")).not.toBeInTheDocument();
  });
});
