import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  autocompletePhotoPlayer: vi.fn(),
  cancelPhotoQuickMatch: vi.fn(),
  connectPhotoRealtime: vi.fn(),
  createPhotoSoloRound: vi.fn(),
  getPhotoGame: vi.fn(),
  getPhotoQuickMatchPools: vi.fn(),
  offerPhotoNoAnswer: vi.fn(),
  revealPhotoSoloAnswer: vi.fn(),
  respondPhotoNoAnswer: vi.fn(),
  submitPhotoGuess: vi.fn(),
  submitPhotoSoloGuess: vi.fn(),
}));

// Recovery cleanup on cancel is asserted via these spies; the real behaviour is
// covered in onlineRecovery.test.js / quickMatchSeats.test.js.
vi.mock("../onlineRecovery", () => ({ clearOnlineInfo: vi.fn() }));
vi.mock("../quickMatchSeats", () => ({ forgetQuickMatchSeat: vi.fn() }));

// Stub the searching lobby so the board's pool-polling hook never runs; the
// lobby itself is covered in QuickMatchSearchingLobby.test.jsx.
vi.mock("../QuickMatchSearchingLobby", () => ({
  default: ({ preset, cancelling, onCancel }) => (
    <div
      data-testid="searching-lobby"
      data-preset={preset}
      data-cancelling={String(cancelling)}
    >
      <button type="button" onClick={onCancel}>
        stub-cancel
      </button>
    </div>
  ),
}));

import PhotoQuizBoard from "../PhotoQuizBoard";
import {
  getRevealCountdownRemaining,
  shouldRevealCompletedRound,
} from "../photoQuizUtils";
import {
  autocompletePhotoPlayer,
  cancelPhotoQuickMatch,
  connectPhotoRealtime,
  createPhotoSoloRound,
  getPhotoGame,
  respondPhotoNoAnswer,
  submitPhotoGuess,
  submitPhotoSoloGuess,
} from "../api";
import { clearOnlineInfo } from "../onlineRecovery";
import { forgetQuickMatchSeat } from "../quickMatchSeats";

let photoRealtimeConnections = [];

beforeEach(() => {
  vi.clearAllMocks();
  photoRealtimeConnections = [];
  connectPhotoRealtime.mockImplementation(({ onMessage, onClose }) => {
    const connection = {
      open: true,
      sent: [],
      send: vi.fn((message) => connection.sent.push(message)),
      close: vi.fn(() => {
        connection.open = false;
      }),
      isOpen: vi.fn(() => connection.open),
      emit: (message) => onMessage(message),
      serverClose: () => {
        connection.open = false;
        onClose?.();
      },
    };
    photoRealtimeConnections.push(connection);
    return connection;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shouldRevealCompletedRound", () => {
  it("does not reveal when no completed round is available", () => {
    expect(shouldRevealCompletedRound(null, null)).toBe(false);
  });

  it("reveals a new completed round once", () => {
    expect(shouldRevealCompletedRound({ round_number: 2 }, 1)).toBe(true);
    expect(shouldRevealCompletedRound({ round_number: 2 }, 2)).toBe(false);
  });
});

describe("getRevealCountdownRemaining", () => {
  it("clamps a server timestamp countdown from 3 to 0", () => {
    const startsAt = "2026-06-15T16:00:03+00:00";

    expect(getRevealCountdownRemaining(startsAt, Date.parse("2026-06-15T16:00:00Z"))).toBe(3);
    expect(getRevealCountdownRemaining(startsAt, Date.parse("2026-06-15T16:00:01.100Z"))).toBe(2);
    expect(getRevealCountdownRemaining(startsAt, Date.parse("2026-06-15T16:00:03Z"))).toBe(0);
    expect(getRevealCountdownRemaining(null, Date.parse("2026-06-15T16:00:00Z"))).toBe(0);
  });
});

describe("PhotoQuizBoard clue", () => {
  it("renders the player photo clue with a non-revealing alt text", () => {
    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const clue = screen.getByTestId("photo-clue-image");
    expect(clue).toHaveAttribute("src", soloPhotoRound().image_url);
    expect(clue).toHaveAttribute("alt", "Mystery player");
  });

  it("shows a loading placeholder when the clue has no image URL", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({
          current_round: {
            round_number: 1,
            status: "active",
            winner_player: null,
            image_url: null,
            resolved_at: null,
          },
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByTestId("photo-clue-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("photo-clue-image")).not.toBeInTheDocument();
  });

  it("falls back to a graceful panel when the clue image fails to load", () => {
    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.error(screen.getByTestId("photo-clue-image"));

    expect(screen.getByTestId("photo-clue-fallback")).toBeInTheDocument();
    expect(screen.getByText("Photo unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("photo-clue-image")).not.toBeInTheDocument();
  });

  it("resets the broken-image fallback on a new round even when the photo URL repeats", () => {
    const repeatedUrl = "https://example.com/players/repeated.png";
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({
          current_round: {
            round_number: 1,
            status: "active",
            winner_player: null,
            image_url: repeatedUrl,
            resolved_at: null,
          },
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.error(screen.getByTestId("photo-clue-image"));
    expect(screen.getByText("Photo unavailable")).toBeInTheDocument();

    emitPhotoRealtimeState({
      state: activePhotoGame({
        round_number: 2,
        current_round: {
          round_number: 2,
          status: "active",
          winner_player: null,
          image_url: repeatedUrl,
          resolved_at: null,
        },
        latest_completed_round: completedRound({ round_number: 1, name: "Prior Answer" }),
      }),
      result: "round_won",
      completedRound: completedRound({ round_number: 1, name: "Prior Answer", winner_player: 1 }),
    });

    expect(screen.queryByText("Photo unavailable")).not.toBeInTheDocument();
    const clue = screen.getByTestId("photo-clue-image");
    expect(clue).toHaveAttribute("src", repeatedUrl);
  });
});

describe("PhotoQuizBoard multiplayer reveals", () => {
  it("renders a prominent multiplayer scoreboard with player scores and race context", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({
          player1_score: 2,
          player2_score: 1,
        })}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const scoreboard = screen.getByLabelText("Photo Quiz multiplayer scoreboard");
    expect(scoreboard).toBeInTheDocument();
    expect(within(scoreboard).getByText("A")).toBeInTheDocument();
    expect(within(scoreboard).getByText("B")).toBeInTheDocument();
    expect(within(scoreboard).getByText("2")).toBeInTheDocument();
    expect(within(scoreboard).getByText("1")).toBeInTheDocument();
    expect(within(scoreboard).getByText("Round 1")).toBeInTheDocument();
    expect(within(scoreboard).getByText("First to 3")).toBeInTheDocument();
    expect(within(scoreboard).getByText("You are B")).toBeInTheDocument();
  });

  it("keeps the multiplayer scoreboard out of solo mode", () => {
    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("Photo Quiz multiplayer scoreboard")).not.toBeInTheDocument();
  });

  it("renders shared wrong guesses for the active round", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({
          wrong_guess_visibility: "shared",
          current_round: {
            ...activePhotoGame().current_round,
            wrong_guesses: [
              { player_number: 1, player: { id: 10, name: "Wrong One", image_url: null } },
              { player_number: 2, player: { id: 11, name: "Wrong Two", image_url: null } },
            ],
          },
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const wrongGuesses = within(screen.getByLabelText("Shared wrong guesses"));
    expect(wrongGuesses.getByText("Wrong One")).toBeInTheDocument();
    expect(wrongGuesses.getByText("Wrong Two")).toBeInTheDocument();
  });

  it("styles multiplayer correct and wrong guess feedback with distinct tones", async () => {
    autocompletePhotoPlayer
      .mockResolvedValueOnce({ players: [{ id: 41, name: "Wrong Player" }] })
      .mockResolvedValueOnce({ players: [{ id: 42, name: "Winning Player" }] });

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectPhotoPlayer("Wrong Player");
    expect(lastPhotoRealtimeConnection().sent).toContainEqual({
      action: "guess",
      player_id: 41,
      round_number: 1,
    });
    emitPhotoRealtimeState({
      state: activePhotoGame(),
      result: "incorrect",
    });

    const wrongFeedback = await screen.findByTestId("photo-feedback-message");
    expect(wrongFeedback).toHaveTextContent("Wrong guess.");
    expect(wrongFeedback).toHaveClass("bg-red-50", "text-red-600");

    await selectPhotoPlayer("Winning Player");
    emitPhotoRealtimeState({
      state: activePhotoGame({
        round_number: 2,
        current_round: { ...activePhotoGame().current_round, round_number: 2 },
        latest_completed_round: completedRound({
          round_number: 1,
          name: "Winning Player",
          status: "completed",
          winner_player: 1,
        }),
      }),
      result: "round_won",
      completedRound: completedRound({
        round_number: 1,
        name: "Winning Player",
        status: "completed",
        winner_player: 1,
      }),
    });

    const successFeedback = await screen.findByTestId("photo-feedback-message");
    expect(successFeedback).toHaveTextContent("Correct!");
    expect(successFeedback).toHaveClass("bg-emerald-50", "text-emerald-700");
  });

  it("does not show personal correct feedback for an opponent win broadcast", () => {
    const wonRound = completedRound({
      round_number: 1,
      name: "Opponent Winner",
      status: "completed",
      winner_player: 1,
    });
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    emitPhotoRealtimeState({
      state: activePhotoGame({
        round_number: 2,
        current_round: { ...activePhotoGame().current_round, round_number: 2 },
        latest_completed_round: wonRound,
      }),
      result: "round_won",
      completedRound: wonRound,
    });

    expect(screen.queryByText("Correct!")).not.toBeInTheDocument();
  });

  it("uses the same feedback tones in solo mode", async () => {
    autocompletePhotoPlayer
      .mockResolvedValueOnce({ players: [{ id: 51, name: "Solo Miss" }] })
      .mockResolvedValueOnce({ players: [{ id: 52, name: "Solo Hit" }] });
    submitPhotoSoloGuess
      .mockResolvedValueOnce({ correct: false })
      .mockResolvedValueOnce({
        correct: true,
        answer: photoAnswer({ id: 52, name: "Solo Hit" }),
      });

    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectPhotoPlayer("Solo Miss");
    const wrongFeedback = await screen.findByTestId("photo-feedback-message");
    expect(wrongFeedback).toHaveTextContent("Not this player. Keep guessing.");
    expect(wrongFeedback).toHaveClass("bg-red-50", "text-red-600");

    await selectPhotoPlayer("Solo Hit");
    const successFeedback = await screen.findByTestId("photo-feedback-message");
    expect(successFeedback).toHaveTextContent("Correct!");
    expect(successFeedback).toHaveClass("bg-emerald-50", "text-emerald-700");
  });

  it("advances to the next solo round tracking recent answers", async () => {
    autocompletePhotoPlayer.mockResolvedValueOnce({ players: [{ id: 52, name: "Solo Hit" }] });
    submitPhotoSoloGuess.mockResolvedValueOnce({
      correct: true,
      answer: photoAnswer({ id: 52, name: "Solo Hit" }),
    });
    createPhotoSoloRound.mockResolvedValueOnce(soloPhotoRound({ round_token: "next-round" }));

    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectPhotoPlayer("Solo Hit");
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));

    await waitFor(() => expect(createPhotoSoloRound).toHaveBeenCalledWith([52]));
  });

  it("shows a polled latest completed round once for a non-acting player", async () => {
    vi.useFakeTimers();
    getPhotoGame.mockResolvedValue(
      activePhotoGame({
        latest_completed_round: completedRound({ round_number: 1, name: "Polled Answer" }),
      })
    );

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText("Answer: Polled Answer")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByText("Answer: Polled Answer")).not.toBeInTheDocument();
  });

  it("shows a server-anchored countdown and disables guessing while locked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T15:59:50Z"));
    getPhotoGame.mockResolvedValue(
      activePhotoGame({
        latest_completed_round: completedRound({
          round_number: 1,
          name: "Timed Answer",
          next_round_starts_at: "2026-06-15T16:00:03+00:00",
        }),
      })
    );

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(screen.getByText("Answer: Timed Answer")).toBeInTheDocument();
    expect(screen.getByText("Next round unlocks in 3")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type a player name...")).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByPlaceholderText("Type a player name...")).not.toBeDisabled();
  });

  it("ignores locked guess conflicts without showing an error", async () => {
    autocompletePhotoPlayer.mockResolvedValue({
      players: [{ id: 99, name: "Locked Player" }],
    });
    submitPhotoGuess.mockRejectedValue(
      Object.assign(new Error("round_locked"), {
        status: 409,
        detail: "round_locked",
      })
    );

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Type a player name..."), {
      target: { value: "locked" },
    });

    await waitFor(() => expect(screen.getByText("Locked Player")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Locked Player"));

    await waitFor(() => expect(submitPhotoGuess).toHaveBeenCalledWith(7, 1, 99, 1));
    expect(screen.queryByText("round_locked")).not.toBeInTheDocument();
  });

  it("resyncs silently when a stale round guess is rejected", async () => {
    autocompletePhotoPlayer.mockResolvedValue({
      players: [{ id: 99, name: "Stale Player" }],
    });
    submitPhotoGuess.mockRejectedValue(
      Object.assign(new Error("round_stale"), {
        status: 409,
        detail: "round_stale",
      })
    );
    getPhotoGame.mockResolvedValue(activePhotoGame({
      round_number: 2,
      current_round: { ...activePhotoGame().current_round, round_number: 2 },
    }));

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Type a player name..."), {
      target: { value: "stale" },
    });

    await waitFor(() => expect(screen.getByText("Stale Player")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Stale Player"));

    await waitFor(() => expect(submitPhotoGuess).toHaveBeenCalledWith(7, 1, 99, 1));
    await waitFor(() => expect(getPhotoGame).toHaveBeenCalledWith(7));
    expect(screen.queryByText("round_stale")).not.toBeInTheDocument();
  });
});

describe("PhotoQuizBoard no-answer responses", () => {
  it("sends the offer version when accepting a no-answer over the websocket", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({
          pending_no_answer_from: 1,
          pending_no_answer_to: 2,
          pending_no_answer_offer_version: 4,
        })}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Accept no answer" }));
    });

    expect(lastPhotoRealtimeConnection().sent).toContainEqual({
      action: "respond_no_answer",
      accept: true,
      round_number: 1,
      no_answer_offer_version: 4,
    });
  });

  it("threads the offer version through the HTTP no-answer response fallback", async () => {
    respondPhotoNoAnswer.mockResolvedValue({
      state: activePhotoGame(),
      result: "no_answer_declined",
    });

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({
          pending_no_answer_from: 2,
          pending_no_answer_to: 1,
          pending_no_answer_offer_version: 5,
        })}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    });

    expect(respondPhotoNoAnswer).toHaveBeenCalledWith(7, 1, false, 1, 5);
  });

  it("hides the respond buttons when no valid offer version is pending", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({
          pending_no_answer_from: 1,
          pending_no_answer_to: 2,
          pending_no_answer_offer_version: null,
        })}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: "Accept no answer" })).not.toBeInTheDocument();
  });
});

describe("PhotoQuizBoard search keyboard submit", () => {
  it("submits the only photo search result when Enter is pressed", async () => {
    autocompletePhotoPlayer.mockResolvedValue({
      players: [{ id: 77, name: "Only Match" }],
    });
    submitPhotoGuess.mockResolvedValue({
      state: activePhotoGame(),
      result: "incorrect",
    });

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Type a player name...");
    fireEvent.change(input, { target: { value: "only" } });

    await screen.findByRole("button", { name: "Only Match" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(submitPhotoGuess).toHaveBeenCalledWith(7, 1, 77, 1));
  });

  it("does not submit photo search when Enter is pressed with multiple results", async () => {
    autocompletePhotoPlayer.mockResolvedValue({
      players: [
        { id: 78, name: "First Match" },
        { id: 79, name: "Second Match" },
      ],
    });

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Type a player name...");
    fireEvent.change(input, { target: { value: "match" } });

    await screen.findByRole("button", { name: "First Match" });
    expect(screen.getByRole("button", { name: "Second Match" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(submitPhotoGuess).not.toHaveBeenCalled();
  });
});

describe("PhotoQuizBoard Quick Match", () => {
  function publicQuickMatchGame(overrides = {}) {
    return activePhotoGame({ is_public: true, preset: "standard", ...overrides });
  }

  it("shows the Quick Match searching lobby for a public preset waiting game", () => {
    render(
      <PhotoQuizBoard
        initialState={publicQuickMatchGame({ status: "waiting_for_opponent" })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByTestId("searching-lobby")).toHaveAttribute("data-preset", "standard");
  });

  it("renders the private WaitingLobby (not the searching lobby) for friend games", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({ status: "waiting_for_opponent" })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByTestId("searching-lobby")).not.toBeInTheDocument();
    expect(screen.getByText("ABC123")).toBeInTheDocument();
  });

  it("cancels a quick match search via the cancel endpoint and clears recovery data", async () => {
    cancelPhotoQuickMatch.mockResolvedValue({ state: { id: 7, status: "cancelled" } });
    const onNewGame = vi.fn();
    render(
      <PhotoQuizBoard
        initialState={publicQuickMatchGame({ status: "waiting_for_opponent" })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={onNewGame}
      />
    );

    fireEvent.click(screen.getByText("stub-cancel"));

    await waitFor(() =>
      expect(cancelPhotoQuickMatch).toHaveBeenCalledWith({ preset: "standard", game_id: 7 })
    );
    await waitFor(() => expect(onNewGame).toHaveBeenCalled());
    expect(clearOnlineInfo).toHaveBeenCalledWith(7);
    expect(forgetQuickMatchSeat).toHaveBeenCalledWith("photo:7");
  });

  it("keeps recovery data and stays put when a cancel fails (already matched)", async () => {
    cancelPhotoQuickMatch.mockRejectedValue(new Error("already matched"));
    const onNewGame = vi.fn();
    render(
      <PhotoQuizBoard
        initialState={publicQuickMatchGame({ status: "waiting_for_opponent" })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={onNewGame}
      />
    );

    fireEvent.click(screen.getByText("stub-cancel"));

    await waitFor(() => expect(cancelPhotoQuickMatch).toHaveBeenCalled());
    expect(clearOnlineInfo).not.toHaveBeenCalled();
    expect(forgetQuickMatchSeat).not.toHaveBeenCalled();
    expect(onNewGame).not.toHaveBeenCalled();
  });

  it("counts down a per-round timer and shows the auto-skip affordance at expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T16:00:00Z"));
    getPhotoGame.mockResolvedValue(publicQuickMatchGame());

    render(
      <PhotoQuizBoard
        initialState={publicQuickMatchGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const timer = screen.getByTestId("photo-round-timer");
    expect(timer).toHaveTextContent("60s left");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByTestId("photo-round-timer")).toHaveTextContent("55s left");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(56000);
    });
    expect(screen.getByTestId("photo-round-timer")).toHaveTextContent("Time's up");
  });

  it("hides the per-round timer and the no-answer flow for public Quick Match games", () => {
    render(
      <PhotoQuizBoard
        initialState={publicQuickMatchGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );
    expect(screen.queryByText("Nobody knows")).not.toBeInTheDocument();

    cleanup();

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );
    expect(screen.queryByTestId("photo-round-timer")).not.toBeInTheDocument();
    expect(screen.getByText("Nobody knows")).toBeInTheDocument();
  });

  it("hides the no-answer flow for a public game even before onlineInfo is recovered", () => {
    // A public game opened/recovered without onlineInfo must still hide the
    // no-answer UI: the backend rejects offers/responses for any public game, so
    // the gating derives from game state rather than transport.
    render(
      <PhotoQuizBoard
        initialState={publicQuickMatchGame()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );
    expect(screen.queryByText("Nobody knows")).not.toBeInTheDocument();
  });
});

function activePhotoGame(overrides = {}) {
  return {
    id: 7,
    mode: "online_friend",
    status: "active",
    join_code: "ABC123",
    target_wins: 3,
    wrong_guess_visibility: "private",
    player1_name: "A",
    player2_name: "B",
    player1_score: 0,
    player2_score: 0,
    round_number: 1,
    winner_player: null,
    pending_no_answer_from: null,
    pending_no_answer_to: null,
    pending_no_answer_offer_version: null,
    current_round: {
      round_number: 1,
      status: "active",
      winner_player: null,
      image_url: "https://example.com/players/clue-1.png",
      resolved_at: null,
    },
    latest_completed_round: null,
    ...overrides,
  };
}

function soloPhotoRound(overrides = {}) {
  return {
    round_token: "solo-round",
    image_url: "https://example.com/players/solo-clue.png",
    ...overrides,
  };
}

function photoAnswer({ id, name }) {
  return {
    id,
    name,
    first_name: name.split(" ")[0],
    last_name: name.split(" ")[1] || "",
    nationality: null,
    position: null,
    image_url: null,
  };
}

async function selectPhotoPlayer(name) {
  fireEvent.change(screen.getByPlaceholderText("Type a player name..."), {
    target: { value: name },
  });
  const option = await screen.findByRole("button", { name });
  await act(async () => {
    fireEvent.click(option);
  });
}

function lastPhotoRealtimeConnection() {
  return photoRealtimeConnections[photoRealtimeConnections.length - 1];
}

function emitPhotoRealtimeState({ state, result = null, completedRound = null }) {
  act(() => {
    lastPhotoRealtimeConnection().emit({
      kind: "state",
      state,
      result,
      completedRound,
      terminal: state?.status === "finished",
    });
  });
}

function completedRound({
  round_number,
  name,
  next_round_starts_at = null,
  image_url = null,
  status = "no_answer",
  winner_player = null,
}) {
  return {
    round_number,
    status,
    winner_player,
    resolved_at: "2026-06-15T16:00:00+00:00",
    next_round_starts_at,
    answer: {
      id: round_number,
      name,
      first_name: name.split(" ")[0],
      last_name: name.split(" ")[1],
      nationality: null,
      position: null,
      image_url,
    },
  };
}
