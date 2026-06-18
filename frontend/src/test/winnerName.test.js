import { describe, it, expect } from "vitest";
import { winnerDisplayName } from "../winnerName";

describe("winnerDisplayName", () => {
  it("returns the named winner for each player", () => {
    expect(
      winnerDisplayName({ winner_player: 1, player1_name: "Alice", player2_name: "Bob" })
    ).toBe("Alice");
    expect(
      winnerDisplayName({ winner_player: 2, player1_name: "Alice", player2_name: "Bob" })
    ).toBe("Bob");
  });

  it("falls back to a generic player label when a winner has no name", () => {
    expect(winnerDisplayName({ winner_player: 1 })).toBe("Player 1");
    expect(winnerDisplayName({ winner_player: 2 })).toBe("Player 2");
  });

  it("returns null when there is no winner (e.g. a public quick-match tie)", () => {
    expect(
      winnerDisplayName({ winner_player: null, player1_name: "Alice", player2_name: "Bob" })
    ).toBeNull();
    expect(winnerDisplayName(null)).toBeNull();
    expect(winnerDisplayName(undefined)).toBeNull();
  });
});
