import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createGame,
  getGame,
  joinGame,
  submitMove,
  giveUpGame,
  quickMatchTicTacToe,
  cancelQuickMatchTicTacToe,
  fetchTicTacToeQuickMatchPools,
  autocompletePlayer,
  connectTicTacToeRealtime,
  createRosterGame,
  createRosterRaceGame,
  joinRosterGame,
  joinRosterRaceGame,
  quickMatchRosterRace,
  cancelRosterRaceQuickMatch,
  getRosterRaceQuickMatchPools,
  submitRosterGuess,
  autocompleteRosterPlayer,
  resignRosterRaceGame,
  createHigherLowerGame,
  submitHigherLowerAnswer,
  getHigherLowerLeaderboard,
  createCareerGame,
  careerQuickMatch,
  cancelCareerQuickMatch,
  fetchCareerSoloHint,
  getCareerQuickMatchPools,
  joinCareerGame,
  offerCareerNoAnswer,
  respondCareerNoAnswer,
  submitCareerGuess,
  resignCareerGame,
  connectCareerRealtime,
  createPhotoSoloRound,
  submitPhotoSoloGuess,
  revealPhotoSoloAnswer,
  autocompletePhotoPlayer,
  createPhotoGame,
  getPhotoGame,
  joinPhotoGame,
  submitPhotoGuess,
  resignPhotoGame,
  offerPhotoNoAnswer,
  respondPhotoNoAnswer,
  connectPhotoRealtime,
} from "../api";

// Identity is mocked so request bodies carry a deterministic guest_id.
vi.mock("../identity", () => ({
  getGuestId: () => "test-guest-id",
}));

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
        body: JSON.stringify({ ...payload, guest_id: "test-guest-id" }),
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
        body: JSON.stringify({
          join_code: "ABC123",
          player_name: "TestPlayer",
          guest_id: "test-guest-id",
        }),
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

  it("connectTicTacToeRealtime opens the websocket path without an auth token", () => {
    class FakeWebSocket {
      static OPEN = 1;
      constructor(url) {
        FakeWebSocket.lastUrl = url;
        this.readyState = FakeWebSocket.OPEN;
      }
      send() {}
      close() {}
    }

    const connection = connectTicTacToeRealtime({
      gameId: 7,
      playerNumber: 2,
      onMessage: vi.fn(),
      WebSocketImpl: FakeWebSocket,
    });

    expect(connection.isOpen()).toBe(true);
    expect(FakeWebSocket.lastUrl).toBe("ws://localhost:8000/quiz/tictactoe/ws/7?player=2");
  });

  it("connectTicTacToeRealtime appends an encoded auth token when supplied", () => {
    class FakeWebSocket {
      static OPEN = 1;
      constructor(url) {
        FakeWebSocket.lastUrl = url;
        this.readyState = FakeWebSocket.OPEN;
      }
      send() {}
      close() {}
    }

    connectTicTacToeRealtime({
      gameId: 7,
      playerNumber: 2,
      onMessage: vi.fn(),
      WebSocketImpl: FakeWebSocket,
      authToken: "abc+/= token",
    });

    const url = new URL(FakeWebSocket.lastUrl);
    expect(url.pathname).toBe("/quiz/tictactoe/ws/7");
    expect(url.searchParams.get("player")).toBe("2");
    expect(url.searchParams.get("token")).toBe("abc+/= token");
  });
});

describe("TicTacToe Quick Match API", () => {
  it("quickMatchTicTacToe posts the preset and guest_id and parses the state envelope", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(stateEnvelope({ id: 31, status: "waiting_for_opponent" }))
    );

    const result = await quickMatchTicTacToe({ preset: "blitz", player_name: "Ace" });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/quick-match",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          preset: "blitz",
          player_name: "Ace",
          guest_id: "test-guest-id",
        }),
      })
    );
    expect(result.state.id).toBe(31);
    expect(result.state.status).toBe("waiting_for_opponent");
  });

  it("cancelQuickMatchTicTacToe posts the game_id, preset and guest_id", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(stateEnvelope({ id: 31, status: "cancelled" }))
    );

    await cancelQuickMatchTicTacToe({ preset: "blitz", game_id: 31 });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/quick-match/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          preset: "blitz",
          game_id: 31,
          guest_id: "test-guest-id",
        }),
      })
    );
  });

  it("fetchTicTacToeQuickMatchPools GETs the presence counts", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse({
        pools: { blitz: { searching: 2, in_progress: 1 } },
        poll_interval_seconds: 5,
      })
    );

    const result = await fetchTicTacToeQuickMatchPools();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/quick-match/pools",
      expect.objectContaining({ method: "GET" })
    );
    expect(result.pools.blitz.searching).toBe(2);
    expect(result.poll_interval_seconds).toBe(5);
  });

  it("giveUpGame appends ?player=N when a player is provided", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(stateEnvelope({ id: 7, status: "finished" }, "resigned"))
    );

    const result = await giveUpGame(7, 2);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/games/7/give-up?player=2",
      expect.objectContaining({ method: "POST" })
    );
    expect(result.result).toBe("resigned");
  });

  it("giveUpGame omits the player query when no player is provided", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(stateEnvelope({ id: 7, status: "finished" }, "gave_up"))
    );

    await giveUpGame(7);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/tictactoe/games/7/give-up",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("Roster Guess API", () => {
  it("createRosterGame sends POST", async () => {
    const payload = { mode: "single_player", season_start: 2020, season_end: 2024 };
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 10 })));
    const result = await createRosterGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/games",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...payload, guest_id: "test-guest-id" }),
      })
    );
    expect(result.state.id).toBe(10);
  });

  it("joinRosterGame sends join_code, player_name and guest_id", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 11 })));
    const result = await joinRosterGame("XYZ789", "Guesser");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/games/join",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          join_code: "XYZ789",
          player_name: "Guesser",
          guest_id: "test-guest-id",
        }),
      })
    );
    expect(result.state.id).toBe(11);
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

  it("submitRosterGuess includes round_number when provided for Race claims", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 10 }, "correct")));

    await submitRosterGuess(10, 456, 3);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/games/10/guess",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ player_id: 456, round_number: 3 }),
      })
    );
  });

  it("createRosterRaceGame sends Race settings and guest_id", async () => {
    const payload = {
      target_wins: 2,
      player1_name: "Ace",
      season_range_start: 2018,
      season_range_end: 2025,
    };
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 12 })));

    const result = await createRosterRaceGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/race/games",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...payload, guest_id: "test-guest-id" }),
      })
    );
    expect(result.state.id).toBe(12);
  });

  it("joinRosterRaceGame sends join_code, player_name and guest_id", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 13 })));

    await joinRosterRaceGame("RACE42", "Runner");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/race/games/join",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          join_code: "RACE42",
          player_name: "Runner",
          guest_id: "test-guest-id",
        }),
      })
    );
  });

  it("quickMatchRosterRace posts preset, name and guest_id", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(stateEnvelope({ id: 14, status: "waiting_for_opponent" }))
    );

    const result = await quickMatchRosterRace({ preset: "modern-standard", player_name: "Ace" });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/quick-match",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          preset: "modern-standard",
          player_name: "Ace",
          guest_id: "test-guest-id",
        }),
      })
    );
    expect(result.state.id).toBe(14);
  });

  it("cancelRosterRaceQuickMatch posts game_id, preset and guest_id", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 14, status: "cancelled" })));

    await cancelRosterRaceQuickMatch({ game_id: 14, preset: "modern-standard" });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/quick-match/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          game_id: 14,
          preset: "modern-standard",
          guest_id: "test-guest-id",
        }),
      })
    );
  });

  it("getRosterRaceQuickMatchPools fetches public Race pool counts", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse({
        pools: { "modern-standard": { searching: 1, in_progress: 2 } },
        poll_interval_seconds: 5,
      })
    );

    const result = await getRosterRaceQuickMatchPools();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/quick-match/pools",
      expect.objectContaining({ method: "GET" })
    );
    expect(result.pools["modern-standard"].in_progress).toBe(2);
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
  it("fetchCareerSoloHint sends round token and progress", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ type: "nationality", nationality: "Serbia" }));

    const result = await fetchCareerSoloHint("round-token", {
      shown_hints: ["nationality"],
      revealed_letters: ["a"],
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/solo/hint",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          round_token: "round-token",
          shown_hints: ["nationality"],
          revealed_letters: ["a"],
        }),
      })
    );
    expect(result.nationality).toBe("Serbia");
  });

  it("createCareerGame parses the realtime state envelope", async () => {
    const payload = { target_wins: 3, wrong_guess_visibility: "private" };
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 })));

    const result = await createCareerGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/games",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...payload, guest_id: "test-guest-id" }),
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
        body: JSON.stringify({
          join_code: "ABC123",
          player_name: "Player 2",
          guest_id: "test-guest-id",
        }),
      })
    );
    expect(result.state.id).toBe(8);
  });

  it("careerQuickMatch posts preset, name and guest_id", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(stateEnvelope({ id: 14, status: "waiting_for_opponent" }))
    );

    const result = await careerQuickMatch({ preset: "standard", player_name: "Ace" });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/quick-match",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          preset: "standard",
          player_name: "Ace",
          guest_id: "test-guest-id",
        }),
      })
    );
    expect(result.state.id).toBe(14);
  });

  it("cancelCareerQuickMatch posts game_id, preset and guest_id", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 14, status: "cancelled" })));

    await cancelCareerQuickMatch({ game_id: 14, preset: "standard" });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/quick-match/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          game_id: 14,
          preset: "standard",
          guest_id: "test-guest-id",
        }),
      })
    );
  });

  it("getCareerQuickMatchPools fetches public Career pool counts", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse({
        pools: { standard: { searching: 1, in_progress: 2 } },
        poll_interval_seconds: 5,
      })
    );

    const result = await getCareerQuickMatchPools();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/quick-match/pools",
      expect.objectContaining({ method: "GET" })
    );
    expect(result.pools.standard.in_progress).toBe(2);
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

describe("Photo Quiz API", () => {
  it("createPhotoSoloRound sends recent player ids", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({
      round_token: "round-token",
      image_url: "https://example.com/p.png",
    }));

    const result = await createPhotoSoloRound([1, 2]);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/solo/round",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ recent_player_ids: [1, 2] }),
      })
    );
    expect(result.round_token).toBe("round-token");
  });

  it("submitPhotoSoloGuess sends round token and player id", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ correct: false }));

    await submitPhotoSoloGuess("round-token", 99);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/solo/guess",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ round_token: "round-token", player_id: 99 }),
      })
    );
  });

  it("revealPhotoSoloAnswer sends the round token", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ answer: { id: 1, name: "Player" } }));

    await revealPhotoSoloAnswer("round-token");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/solo/reveal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ round_token: "round-token" }),
      })
    );
  });

  it("autocompletePhotoPlayer hits the photo autocomplete path", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ players: [] }));

    await autocompletePhotoPlayer("luka");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/players/autocomplete?q=luka&limit=15",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("createPhotoGame parses the realtime state envelope", async () => {
    const payload = { target_wins: 3, wrong_guess_visibility: "private" };
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 })));

    const result = await createPhotoGame(payload);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/games",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...payload, guest_id: "test-guest-id" }),
      })
    );
    expect(result.state.id).toBe(7);
  });

  it("getPhotoGame fetches plain game state for polling", async () => {
    mockFetch.mockReturnValue(mockJsonResponse({ id: 7, status: "active" }));

    const result = await getPhotoGame(7);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/games/7",
      expect.objectContaining({ method: "GET" })
    );
    expect(result.id).toBe(7);
  });

  it("joinPhotoGame parses the realtime state envelope", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 8 })));

    const result = await joinPhotoGame("ABC123", "Player 2");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/games/join",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          join_code: "ABC123",
          player_name: "Player 2",
          guest_id: "test-guest-id",
        }),
      })
    );
    expect(result.state.id).toBe(8);
  });

  it("submitPhotoGuess sends player_id and round_number", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 }, "incorrect")));

    const result = await submitPhotoGuess(7, 1, 99, 3);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/games/7/guess?player=1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ player_id: 99, round_number: 3 }),
      })
    );
    expect(result.result).toBe("incorrect");
  });

  it("offerPhotoNoAnswer sends round_number", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 }, "no_answer_offered")));

    const result = await offerPhotoNoAnswer(7, 2, 4);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/games/7/no-answer-offer?player=2",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ round_number: 4 }),
      })
    );
    expect(result.result).toBe("no_answer_offered");
  });

  it("respondPhotoNoAnswer sends accept, round_number and offer version", async () => {
    mockFetch.mockReturnValue(mockJsonResponse(stateEnvelope({ id: 7 }, "no_answer_accepted")));

    const result = await respondPhotoNoAnswer(7, 1, true, 4, 2);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/games/7/no-answer-response?player=1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          accept: true,
          round_number: 4,
          no_answer_offer_version: 2,
        }),
      })
    );
    expect(result.result).toBe("no_answer_accepted");
  });

  it("connectPhotoRealtime opens the Photo websocket path", () => {
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

    const connection = connectPhotoRealtime({
      gameId: 7,
      playerNumber: 2,
      onMessage: vi.fn(),
      WebSocketImpl: FakeWebSocket,
    });
    connection.send({
      action: "respond_no_answer",
      accept: true,
      round_number: 1,
      no_answer_offer_version: 3,
    });

    expect(connection.isOpen()).toBe(true);
    expect(FakeWebSocket.lastUrl).toBe("ws://localhost:8000/quiz/photo/ws/7?player=2");
    expect(messages).toEqual([{
      action: "respond_no_answer",
      accept: true,
      round_number: 1,
      no_answer_offer_version: 3,
    }]);
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

describe("Online resign endpoints", () => {
  it("resignCareerGame POSTs the give-up endpoint with the player query", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(
        stateEnvelope({ id: 7, status: "finished", winner_player: 2 }, "resigned")
      )
    );

    const result = await resignCareerGame(7, 1);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/career/games/7/give-up?player=1",
      expect.objectContaining({ method: "POST" })
    );
    expect(result.result).toBe("resigned");
    expect(result.state.status).toBe("finished");
  });

  it("resignPhotoGame POSTs the give-up endpoint with the player query", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(
        stateEnvelope({ id: 9, status: "finished", winner_player: 1 }, "resigned")
      )
    );

    const result = await resignPhotoGame(9, 2);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/photo/games/9/give-up?player=2",
      expect.objectContaining({ method: "POST" })
    );
    expect(result.result).toBe("resigned");
  });

  it("resignRosterRaceGame POSTs the give-up endpoint with the player query", async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse(
        stateEnvelope({ id: 30, status: "finished", winner_player: 2 }, "resigned")
      )
    );

    const result = await resignRosterRaceGame(30, 1);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8000/quiz/roster-guess/games/30/give-up?player=1",
      expect.objectContaining({ method: "POST" })
    );
    expect(result.result).toBe("resigned");
  });
});
