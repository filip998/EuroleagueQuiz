import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import GameBoard from "../GameBoard";
import { buildInviteUrl } from "../inviteLink";

// Avoid opening a real WebSocket in the waiting-lobby render path.
vi.mock("../useOnlineGameRealtime", () => ({
  useOnlineGameRealtime: () => ({}),
}));

// Capture the props GameBoard hands to the shared lobby.
vi.mock("../WaitingLobby", () => ({
  default: ({ joinCode, inviteUrl }) => (
    <div
      data-testid="waiting-lobby"
      data-join-code={joinCode}
      data-invite-url={inviteUrl}
    />
  ),
}));

describe("GameBoard waiting lobby", () => {
  it("passes a shareable invite URL built from the join code", () => {
    render(
      <GameBoard
        initialState={{ id: 7, status: "waiting_for_opponent", join_code: "ABC123" }}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    const lobby = screen.getByTestId("waiting-lobby");
    expect(lobby).toHaveAttribute("data-join-code", "ABC123");
    expect(lobby).toHaveAttribute("data-invite-url", buildInviteUrl("ABC123"));
  });
});
