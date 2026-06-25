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
  resignPhotoGame: vi.fn(),
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
  revealPhotoSoloAnswer,
  submitPhotoGuess,
  submitPhotoSoloGuess,
  resignPhotoGame,
} from "../api";
import { clearOnlineInfo } from "../onlineRecovery";
import { forgetQuickMatchSeat } from "../quickMatchSeats";
import { buildInviteUrl } from "../inviteLink";

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

  it("rewrites an EuroLeague CDN clue to a width-bounded webp with a high-DPI srcSet", () => {
    const cdn = "https://media-cdn.incrowdsports.com/abc-123.png";
    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound({ image_url: cdn })}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const clue = screen.getByTestId("photo-clue-image");
    expect(clue).toHaveAttribute("src", `${cdn}?width=384&format=webp`);
    expect(clue).toHaveAttribute(
      "srcset",
      `${cdn}?width=384&format=webp 384w, ${cdn}?width=768&format=webp 768w`
    );
    expect(clue).toHaveAttribute("sizes");
  });

  it("retries the original CDN url before showing the fallback panel", () => {
    const cdn = "https://media-cdn.incrowdsports.com/abc-123.png";
    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound({ image_url: cdn })}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    // First failure (optimized webp): swap to the untouched original, keep the img.
    fireEvent.error(screen.getByTestId("photo-clue-image"));
    const clue = screen.getByTestId("photo-clue-image");
    expect(clue).toHaveAttribute("src", cdn);
    expect(clue).not.toHaveAttribute("srcset");
    expect(screen.queryByTestId("photo-clue-fallback")).not.toBeInTheDocument();

    // Original also fails: now show the graceful placeholder.
    fireEvent.error(clue);
    expect(screen.getByTestId("photo-clue-fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("photo-clue-image")).not.toBeInTheDocument();
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
    expect(within(scoreboard).getByText("ONLINE RACE")).toBeInTheDocument();
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

  it("styles multiplayer wrong-guess feedback and never bleeds a win banner into the next round", async () => {
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
    expect(wrongFeedback).not.toHaveClass("bg-emerald-50");

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

    // The won round's outcome is carried by the reveal card; once the round
    // advances no transient guess banner may persist over the new round (#282).
    await screen.findByText("Player 1 wins the round");
    expect(screen.queryByText("Correct!")).not.toBeInTheDocument();
    expect(screen.queryByText("Wrong guess.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-feedback-message")).not.toBeInTheDocument();
  });

  it("clears a stale wrong-guess banner when a public Quick Match round auto-skips on timeout", async () => {
    autocompletePhotoPlayer.mockResolvedValueOnce({
      players: [{ id: 41, name: "Wrong Player" }],
    });

    const publicGame = (overrides = {}) => activePhotoGame({
      is_public: true,
      preset: "standard",
      ...overrides,
    });

    render(
      <PhotoQuizBoard
        initialState={publicGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectPhotoPlayer("Wrong Player");
    emitPhotoRealtimeState({
      state: publicGame(),
      result: "incorrect",
    });
    expect(await screen.findByText("Wrong guess.")).toBeInTheDocument();

    // The shared round timer expiry advances the round with a time_expired
    // result; the stale "Wrong guess." banner must not bleed into it (#282).
    emitPhotoRealtimeState({
      state: publicGame({
        round_number: 2,
        current_round: {
          ...publicGame().current_round,
          round_number: 2,
        },
        latest_completed_round: completedRound({
          round_number: 1,
          name: "Skipped Player",
          status: "completed",
          winner_player: null,
        }),
      }),
      result: "time_expired",
      completedRound: completedRound({
        round_number: 1,
        name: "Skipped Player",
        status: "completed",
        winner_player: null,
      }),
    });

    await screen.findByText("No answer");
    expect(screen.queryByText("Wrong guess.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-feedback-message")).not.toBeInTheDocument();
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

describe("PhotoQuizBoard solo HUD", () => {
  it("shows the solo objective and a starting Solved/Streak score in the top HUD", () => {
    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByText("Name the player")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Solved 0" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Streak 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reveal answer" })).toBeInTheDocument();
  });

  it("keeps the solo objective and score out of multiplayer", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByText("Name the player")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Solved 0" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal answer" })).not.toBeInTheDocument();
  });

  it("increments Solved and Streak on a correct solo guess and carries the score into the next round", async () => {
    autocompletePhotoPlayer
      .mockResolvedValueOnce({ players: [{ id: 52, name: "First Hit" }] })
      .mockResolvedValueOnce({ players: [{ id: 53, name: "Second Hit" }] });
    submitPhotoSoloGuess
      .mockResolvedValueOnce({ correct: true, answer: photoAnswer({ id: 52, name: "First Hit" }) })
      .mockResolvedValueOnce({ correct: true, answer: photoAnswer({ id: 53, name: "Second Hit" }) });
    createPhotoSoloRound.mockResolvedValueOnce(soloPhotoRound({ round_token: "next-round" }));

    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByRole("group", { name: "Solved 0" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Streak 0" })).toBeInTheDocument();

    await selectPhotoPlayer("First Hit");

    expect(await screen.findByRole("group", { name: "Solved 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Streak 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    await waitFor(() => expect(createPhotoSoloRound).toHaveBeenCalledWith([52]));

    await selectPhotoPlayer("Second Hit");

    expect(await screen.findByRole("group", { name: "Solved 2" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Streak 2" })).toBeInTheDocument();
    // The second guess must run against the advanced round token, proving the
    // score carried forward into a genuinely new round rather than re-scoring
    // the first one.
    expect(submitPhotoSoloGuess).toHaveBeenNthCalledWith(1, "solo-round", 52);
    expect(submitPhotoSoloGuess).toHaveBeenNthCalledWith(2, "next-round", 53);
  });

  it("keeps the streak intact across a wrong guess before a correct solo answer", async () => {
    autocompletePhotoPlayer
      .mockResolvedValueOnce({ players: [{ id: 60, name: "Wrong One" }] })
      .mockResolvedValueOnce({ players: [{ id: 61, name: "Right One" }] });
    submitPhotoSoloGuess
      .mockResolvedValueOnce({ correct: false })
      .mockResolvedValueOnce({ correct: true, answer: photoAnswer({ id: 61, name: "Right One" }) });

    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectPhotoPlayer("Wrong One");

    expect(screen.getByRole("group", { name: "Solved 0" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Streak 0" })).toBeInTheDocument();

    await selectPhotoPlayer("Right One");

    expect(await screen.findByRole("group", { name: "Solved 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Streak 1" })).toBeInTheDocument();
  });

  it("resets the streak but keeps Solved when the answer is revealed", async () => {
    autocompletePhotoPlayer.mockResolvedValueOnce({ players: [{ id: 70, name: "Solved One" }] });
    submitPhotoSoloGuess.mockResolvedValueOnce({
      correct: true,
      answer: photoAnswer({ id: 70, name: "Solved One" }),
    });
    createPhotoSoloRound.mockResolvedValueOnce(soloPhotoRound({ round_token: "round-2" }));
    revealPhotoSoloAnswer.mockResolvedValueOnce({
      answer: photoAnswer({ id: 71, name: "Revealed One" }),
    });

    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectPhotoPlayer("Solved One");
    expect(await screen.findByRole("group", { name: "Streak 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    await waitFor(() => expect(createPhotoSoloRound).toHaveBeenCalledWith([70]));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reveal answer" }));
    });

    expect(await screen.findByRole("group", { name: "Solved 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Streak 0" })).toBeInTheDocument();
    expect(screen.getByText("Revealed One")).toBeInTheDocument();
  });

  it("locks the solo guess controls while a guess is in flight so a round counts once", async () => {
    autocompletePhotoPlayer.mockResolvedValueOnce({ players: [{ id: 80, name: "Once Only" }] });
    let resolveGuess;
    submitPhotoSoloGuess.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGuess = resolve;
      })
    );

    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectPhotoPlayer("Once Only");

    // While the guess is in flight the input and Reveal answer are disabled, so
    // the same round cannot be submitted (or resolved) twice.
    expect(screen.getByPlaceholderText("Type a player name...")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reveal answer" })).toBeDisabled();

    await act(async () => {
      resolveGuess({ correct: true, answer: photoAnswer({ id: 80, name: "Once Only" }) });
    });

    expect(await screen.findByRole("group", { name: "Solved 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Streak 1" })).toBeInTheDocument();
    expect(submitPhotoSoloGuess).toHaveBeenCalledTimes(1);
  });

  it("locks Reveal answer while a reveal is in flight so it resolves once", async () => {
    let resolveReveal;
    revealPhotoSoloAnswer.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReveal = resolve;
      })
    );

    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const revealButton = screen.getByRole("button", { name: "Reveal answer" });
    await act(async () => {
      fireEvent.click(revealButton);
    });

    // The button disables while the reveal is in flight, so a second click
    // cannot resolve the round twice.
    expect(revealButton).toBeDisabled();
    fireEvent.click(revealButton);

    await act(async () => {
      resolveReveal({ answer: photoAnswer({ id: 90, name: "Revealed Once" }) });
    });

    expect(await screen.findByText("Revealed Once")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Streak 0" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Solved 0" })).toBeInTheDocument();
    expect(revealPhotoSoloAnswer).toHaveBeenCalledTimes(1);
  });

  it("clears the solo wrong-guess banner when the answer is revealed", async () => {
    autocompletePhotoPlayer.mockResolvedValueOnce({ players: [{ id: 55, name: "Solo Miss" }] });
    submitPhotoSoloGuess.mockResolvedValueOnce({ correct: false });
    revealPhotoSoloAnswer.mockResolvedValueOnce({
      answer: photoAnswer({ id: 56, name: "Revealed Star" }),
    });

    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectPhotoPlayer("Solo Miss");
    expect(await screen.findByText("Not this player. Keep guessing.")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reveal answer" }));
    });

    // Revealing the answer must drop the stale wrong-guess banner instead of
    // leaving it stacked above the revealed player (issue #282).
    expect(await screen.findByText("Revealed Star")).toBeInTheDocument();
    expect(screen.queryByText("Not this player. Keep guessing.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-feedback-message")).not.toBeInTheDocument();
  });

  it("leaves no solo feedback banner when advancing to the next photo after a reveal", async () => {
    autocompletePhotoPlayer.mockResolvedValueOnce({ players: [{ id: 57, name: "Solo Miss" }] });
    submitPhotoSoloGuess.mockResolvedValueOnce({ correct: false });
    revealPhotoSoloAnswer.mockResolvedValueOnce({
      answer: photoAnswer({ id: 58, name: "Revealed Star" }),
    });
    createPhotoSoloRound.mockResolvedValueOnce(soloPhotoRound({ round_token: "next-round" }));

    render(
      <PhotoQuizBoard
        soloInitialRound={soloPhotoRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectPhotoPlayer("Solo Miss");
    expect(await screen.findByText("Not this player. Keep guessing.")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reveal answer" }));
    });
    await screen.findByText("Revealed Star");

    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    await waitFor(() => expect(createPhotoSoloRound).toHaveBeenCalled());

    expect(screen.queryByText("Not this player. Keep guessing.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-feedback-message")).not.toBeInTheDocument();
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
    expect(screen.queryByTestId("photo-no-answer-offer-prompt")).not.toBeInTheDocument();
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

  it("highlights with ArrowDown and submits the highlighted photo result on Enter", async () => {
    autocompletePhotoPlayer.mockResolvedValue({
      players: [
        { id: 78, name: "First Match" },
        { id: 79, name: "Second Match" },
      ],
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
    fireEvent.change(input, { target: { value: "match" } });

    const first = await screen.findByRole("button", { name: "First Match" });
    const second = screen.getByRole("button", { name: "Second Match" });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(first).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("aria-selected", "false");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(submitPhotoGuess).toHaveBeenCalledWith(7, 1, 79, 1));
  });

  it("clears the guess box query and autocomplete results when the online round changes", async () => {
    autocompletePhotoPlayer.mockResolvedValue({
      players: [{ id: 81, name: "Stale Match" }],
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
    fireEvent.change(input, { target: { value: "stale" } });
    await screen.findByRole("button", { name: "Stale Match" });
    expect(input).toHaveValue("stale");

    emitPhotoRealtimeState({
      state: activePhotoGame({
        round_number: 2,
        current_round: {
          ...activePhotoGame().current_round,
          round_number: 2,
        },
        latest_completed_round: completedRound({
          round_number: 1,
          name: "Opponent Pick",
          status: "completed",
          winner_player: 2,
        }),
      }),
      result: "round_won",
      completedRound: completedRound({
        round_number: 1,
        name: "Opponent Pick",
        status: "completed",
        winner_player: 2,
      }),
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Type a player name...")).toHaveValue("");
    });
    expect(screen.queryByRole("button", { name: "Stale Match" })).not.toBeInTheDocument();
  });

  it("keeps the guess box query while the same online round continues", async () => {
    autocompletePhotoPlayer.mockResolvedValue({
      players: [{ id: 82, name: "Same Round Match" }],
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
    fireEvent.change(input, { target: { value: "same" } });
    await screen.findByRole("button", { name: "Same Round Match" });

    emitPhotoRealtimeState({ state: activePhotoGame() });

    expect(input).toHaveValue("same");
    expect(screen.getByRole("button", { name: "Same Round Match" })).toBeInTheDocument();
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
    // Public quick-match games hide the join code, so no invite link must leak.
    expect(screen.queryByText("Copy link")).not.toBeInTheDocument();
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

  it("renders and copies a shareable invite link in the private friend lobby", async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    const inviteUrl = buildInviteUrl("ABC123", "/photo");

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({ status: "waiting_for_opponent" })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(inviteUrl).toContain("/photo?join=ABC123");
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText(inviteUrl)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Copy link"));
    expect(writeText).toHaveBeenCalledWith(inviteUrl);
    expect(await screen.findByText("Link copied!")).toBeInTheDocument();
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

  it("counts the scoreboard timer down and shows the auto-skip affordance at expiry", async () => {
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

    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("10");
    expect(timer).toHaveAttribute("aria-label", "10 seconds left");
    expect(screen.queryByTestId("photo-round-timer")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("5");
    expect(screen.queryByTestId("photo-round-timer")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11000);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("0");
    expect(screen.getByTestId("photo-round-timer")).toHaveTextContent("Time's up");
  });

  it("shows the scoreboard countdown and the mutual no-answer offer for public Quick Match games", () => {
    render(
      <PhotoQuizBoard
        initialState={publicQuickMatchGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );
    expect(screen.getByRole("timer")).toHaveTextContent("10");
    expect(screen.queryByTestId("photo-round-timer")).not.toBeInTheDocument();
    expect(screen.getByText("Nobody knows")).toBeInTheDocument();

    cleanup();

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-round-timer")).not.toBeInTheDocument();
    expect(screen.getByText("Nobody knows")).toBeInTheDocument();
  });

  it("shows the no-answer offer for a recovered public game before realtime reconnects", () => {
    render(
      <PhotoQuizBoard
        initialState={publicQuickMatchGame()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );
    expect(screen.getByText("Nobody knows")).toBeInTheDocument();
  });

  it("shows public Quick Match no-answer response controls to the targeted player", () => {
    render(
      <PhotoQuizBoard
        initialState={publicQuickMatchGame({
          pending_no_answer_from: 1,
          pending_no_answer_to: 2,
          pending_no_answer_offer_version: 8,
        })}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Accept no answer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    expect(screen.getByTestId("photo-no-answer-offer-prompt")).toHaveTextContent(
      "Your opponent doesn't know — accept to reveal the answer and skip this round, or decline to keep playing."
    );
    expect(screen.getByRole("button", { name: "Accept no answer" })).toHaveAttribute(
      "aria-describedby",
      "photo-no-answer-offer-prompt"
    );
    expect(screen.getByRole("button", { name: "Decline" })).toHaveAttribute(
      "aria-describedby",
      "photo-no-answer-offer-prompt"
    );
  });
});

describe("PhotoQuizBoard online resign", () => {
  it("resigns through the give-up endpoint and shows the self-resign outcome", async () => {
    resignPhotoGame.mockResolvedValue({
      state: activePhotoGame({ status: "finished", winner_player: 2 }),
      result: "resigned",
    });

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Resign"));
    expect(
      screen.getByText("Resign the match? Your opponent wins.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Resign"));

    await waitFor(() => expect(resignPhotoGame).toHaveBeenCalledWith(7, 1));
    expect(await screen.findByText("You resigned.")).toBeInTheDocument();
  });

  it("renders an opponent resignation delivered over realtime", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    emitPhotoRealtimeState({
      state: activePhotoGame({ status: "finished", winner_player: 2 }),
      result: "resigned",
    });

    expect(screen.getByText("Your opponent resigned.")).toBeInTheDocument();
  });

  it("does not offer a resign control once the game is finished", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({ status: "finished", winner_player: 2 })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByText("Resign")).not.toBeInTheDocument();
  });

  it("does not credit Player 2 when an unattended public game has no winner", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({ status: "finished", winner_player: null })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "No winner" })).toBeInTheDocument();
    expect(screen.queryByText("B WINS!")).not.toBeInTheDocument();
  });

  it("hides the resign control during the inter-round reveal lock", () => {
    render(
      <PhotoQuizBoard
        initialState={activePhotoGame({
          latest_completed_round: completedRound({
            round_number: 1,
            name: "Locked Player",
            next_round_starts_at: new Date(Date.now() + 10_000).toISOString(),
          }),
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByPlaceholderText("Type a player name...")).toBeDisabled();
    expect(screen.queryByText("Resign")).not.toBeInTheDocument();
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

describe("PhotoQuizBoard header navigation", () => {
  it("exposes a single consistent Home control that returns to the app home", () => {
    const onHome = vi.fn();
    const onNewGame = vi.fn();

    render(
      <PhotoQuizBoard
        initialState={activePhotoGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={onHome}
        onNewGame={onNewGame}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));

    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onNewGame).not.toHaveBeenCalled();
  });
});
