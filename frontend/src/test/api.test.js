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
  createCareerGame,
  joinCareerGame,
  offerCareerNoAnswer,
  respondCareerNoAnswer,
  submitCareerGuess,
  connectCareerRealtime,
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

function stateEnvelope(game, result = null) {
  return {
    type: "state",
    payload: {
      game,
      ...(result ? { result } : {}),
      terminal: game.status === "finished",
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("TicTacToe API", () => {
  it("createGame sends POST with correct payload", async () => {
    const payload = { mode: "single_player", target_wins: 3 };
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 1 })));

    const result = await createGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/games",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      })
    );
    expect(result.state.id).toBe(1);
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
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 5 })));
    const result = await joinGame("ABC123", "TestPlayer");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/games/join",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ join_code: "ABC123", player_name: "TestPlayer" }),
      })
    );
    expect(result.state.id).toBe(5);
  });

  it("submitMove sends move data", async () => {
    const move = { row_index: 0, col_index: 1, player_id: 123 };
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 }, "correct")));
    const result = await submitMove(7, move);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/games/7/moves",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(move),
      })
    );
    expect(result.result).toBe("correct");
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
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 10 })));
    const result = await createRosterGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/games",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) })
    );
    expect(result.state.id).toBe(10);
  });

  it("submitRosterGuess sends player_id", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 10 }, "correct")));
    const result = await submitRosterGuess(10, 456);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/games/10/guess",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ player_id: 456 }),
      })
    );
    expect(result.result).toBe("correct");
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

describe("Career Quiz API", () => {
  it("createCareerGame parses the realtime state envelope", async () => {
    const payload = { target_wins: 3, wrong_guess_visibility: "private" };
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 })));

    const result = await createCareerGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/games",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      })
    );
    expect(result.state.id).toBe(7);
  });

  it("joinCareerGame parses the realtime state envelope", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 8 })));

    const result = await joinCareerGame("ABC123", "Player 2");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/games/join",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ join_code: "ABC123", player_name: "Player 2" }),
      })
    );
    expect(result.state.id).toBe(8);
  });

  it("submitCareerGuess sends player_id and round_number", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 }, "incorrect")));

    const result = await submitCareerGuess(7, 1, 99, 3);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/games/7/guess?player=1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ player_id: 99, round_number: 3 }),
      })
    );
    expect(result.result).toBe("incorrect");
  });

  it("offerCareerNoAnswer sends round_number", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 }, "no_answer_offered")));

    const result = await offerCareerNoAnswer(7, 2, 4);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/games/7/no-answer-offer?player=2",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ round_number: 4 }),
      })
    );
    expect(result.result).toBe("no_answer_offered");
  });

  it("respondCareerNoAnswer sends accept and round_number", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 }, "no_answer_accepted")));

    const result = await respondCareerNoAnswer(7, 1, true, 4);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/games/7/no-answer-response?player=1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ accept: true, round_number: 4 }),
      })
    );
    expect(result.result).toBe("no_answer_accepted");
  });

  it("connectCareerRealtime opens the Career websocket path", () => {
    const messages = [];
    class FakeWebSocket {
      static OPEN = 1;
      constructor(url) {
        FakeWebSocket.lastUrl = url;
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
      }
      send(message) {
        messages.push(JSON.parse(message));
      }
      close() {}
    }

    const connection = connectCareerRealtime({
      gameId: 7,
      playerNumber: 2,
      onMessage: vi.fn(),
      WebSocketImpl: FakeWebSocket,
    });
    connection.send({ action: "offer_no_answer", round_number: 1 });

    expect(connection.isOpen()).toBe(true);
    expect(FakeWebSocket.lastUrl).toBe("ws://localhost:8000/quiz/career/ws/7?player=2");
    expect(messages).toEqual([{ action: "offer_no_answer", round_number: 1 }]);
  });
});

describe("Error handling", () => {
  it("throws error with detail message on non-ok response", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse({ detail: "Game not found" }, false)
    );

    await expect(getGame(999)).rejects.toThrow("Game not found");
  });

  it("throws error with realtime error envelope message on non-ok response", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(
        {
          type: "error",
          payload: { code: "conflict", message: "It is not your turn" },
        },
        false
      )
    );

    await expect(submitMove(7, { row_index: 0, col_index: 0, player_id: 1 })).rejects.toThrow(
      "It is not your turn"
    );
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
