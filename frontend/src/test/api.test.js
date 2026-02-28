import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createGame,
  getGame,
  joinGame,
  submitMove,
  autocompletePlayer,
  createRosterGame,
  submitRosterGuess,
  autocompleteRosterPlayer,
  createHigherLowerGame,
  submitHigherLowerAnswer,
  getHigherLowerLeaderboard,
} from "../api";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockJsonResponse(data, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? "OK" : "Bad Request",
    json: () => Promise.resolve(data),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("TicTacToe API", () => {
  it("createGame sends POST with correct payload", async () => {
    const payload = { mode: "single_player", target_wins: 3 };
    mockFetch.mockReturnValue(mockJsonResponse({ game_id: 1 }));

    const result = await createGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/games",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      })
    );
    expect(result.game_id).toBe(1);
  });

  it("getGame sends GET to correct path", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ game_id: 42 }));
    const result = await getGame(42);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/games/42",
      expect.objectContaining({ method: "GET" })
    );
    expect(result.game_id).toBe(42);
  });

  it("joinGame sends join_code and player_name", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ game_id: 5 }));
    await joinGame("ABC123", "TestPlayer");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/games/join",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ join_code: "ABC123", player_name: "TestPlayer" }),
      })
    );
  });

  it("submitMove sends move data", async () => {
    const move = { row_index: 0, col_index: 1, player_id: 123 };
    mockFetch.mockReturnValue(mockJsonResponse({ result: "correct" }));
    await submitMove(7, move);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/games/7/moves",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(move),
      })
    );
  });

  it("autocompletePlayer includes team codes in query params", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ players: [] }));
    await autocompletePlayer("luka", "BAR", "RMB", 10);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain("/quiz/tictactoe/players/autocomplete");
    expect(calledUrl).toContain("q=luka");
    expect(calledUrl).toContain("team_code_1=BAR");
    expect(calledUrl).toContain("team_code_2=RMB");
    expect(calledUrl).toContain("limit=10");
  });
});

describe("Roster Guess API", () => {
  it("createRosterGame sends POST", async () => {
    const payload = { mode: "single_player", season_start: 2020, season_end: 2024 };
    mockFetch.mockReturnValue(mockJsonResponse({ game_id: 10 }));
    await createRosterGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/games",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) })
    );
  });

  it("submitRosterGuess sends player_id", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ result: "correct" }));
    await submitRosterGuess(10, 456);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/games/10/guess",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ player_id: 456 }),
      })
    );
  });

  it("autocompleteRosterPlayer sends query", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ players: [] }));
    await autocompleteRosterPlayer("doncic", 5);

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain("/quiz/roster-guess/players/autocomplete");
    expect(calledUrl).toContain("q=doncic");
    expect(calledUrl).toContain("limit=5");
  });
});

describe("Higher or Lower API", () => {
  it("createHigherLowerGame sends POST", async () => {
    const payload = { tier: "easy", season_start: 2020, season_end: 2024 };
    mockFetch.mockReturnValue(mockJsonResponse({ game_id: 20 }));
    await createHigherLowerGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/higher-lower/games",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) })
    );
  });

  it("submitHigherLowerAnswer sends choice", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ correct: true, streak: 5 }));
    const result = await submitHigherLowerAnswer(20, "left");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/higher-lower/games/20/answer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ choice: "left" }),
      })
    );
    expect(result.correct).toBe(true);
  });

  it("getHigherLowerLeaderboard sends GET with tier", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ entries: [] }));
    await getHigherLowerLeaderboard("hard");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/higher-lower/leaderboard/hard",
      expect.objectContaining({ method: "GET" })
    );
  });
});

describe("Error handling", () => {
  it("throws error with detail message on non-ok response", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse({ detail: "Game not found" }, false)
    );

    await expect(getGame(999)).rejects.toThrow("Game not found");
  });

  it("throws error with status text if no detail", async () => {
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(),
      })
    );

    await expect(getGame(999)).rejects.toThrow("Internal Server Error");
  });
});
