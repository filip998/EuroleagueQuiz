import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  autocompleteCareerPlayer: vi.fn(),
  cancelCareerQuickMatch: vi.fn(),
  connectCareerRealtime: vi.fn(),
  createCareerSoloRound: vi.fn(),
  fetchCareerSoloHint: vi.fn(),
  getCareerGame: vi.fn(),
  getCareerQuickMatchPools: vi.fn(),
  offerCareerNoAnswer: vi.fn(),
  revealCareerSoloAnswer: vi.fn(),
  respondCareerNoAnswer: vi.fn(),
  submitCareerGuess: vi.fn(),
  submitCareerSoloGuess: vi.fn(),
  resignCareerGame: vi.fn(),
}));

import CareerQuizBoard from "../CareerQuizBoard";
import {
  formatSeasonRange,
  getRevealCountdownRemaining,
  shouldRevealCompletedRound,
} from "../careerQuizUtils";
import {
  autocompleteCareerPlayer,
  cancelCareerQuickMatch,
  connectCareerRealtime,
  createCareerSoloRound,
  fetchCareerSoloHint,
  getCareerGame,
  getCareerQuickMatchPools,
  submitCareerGuess,
  submitCareerSoloGuess,
  resignCareerGame,
} from "../api";
import { buildInviteUrl } from "../inviteLink";

let careerRealtimeConnections = [];

beforeEach(() => {
  vi.clearAllMocks();
  careerRealtimeConnections = [];
  getCareerQuickMatchPools.mockResolvedValue({
    pools: { standard: { searching: 1, in_progress: 0 } },
    poll_interval_seconds: 5,
  });
  cancelCareerQuickMatch.mockResolvedValue({
    state: { id: 10, status: "cancelled" },
  });
  connectCareerRealtime.mockImplementation(({ onMessage, onClose }) => {
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
    careerRealtimeConnections.push(connection);
    return connection;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatSeasonRange", () => {
  it("prefers Wikipedia-style years when provided", () => {
    expect(formatSeasonRange({
      years: "1999\u20132004",
      start_season: "1999/00",
      end_season: "2003/04",
    })).toBe("1999\u20132004");
  });

  it("shows a single Wikipedia year", () => {
    expect(formatSeasonRange({ years: "2010" })).toBe("2010");
  });

  it("shows open-ended current stints in Wikipedia style", () => {
    expect(formatSeasonRange({ years: "2024\u2013present" })).toBe("2024\u2013present");
  });

  it("falls back to season labels when years missing", () => {
    expect(formatSeasonRange({
      start_season: "2020/21",
      end_season: "2020/21",
    })).toBe("2020/21");
    expect(formatSeasonRange({
      start_season: "2023/24",
      end_season: null,
    })).toBe("2023/24 \u2013 present");
  });
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

describe("CareerQuizBoard multiplayer reveals", () => {
  it("renders a prominent multiplayer scoreboard with player scores and race context", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({
          player1_score: 2,
          player2_score: 1,
        })}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const scoreboard = screen.getByLabelText("Career Quiz multiplayer scoreboard");
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
      <CareerQuizBoard
        soloInitialRound={{
          round_token: "solo-round",
          timeline: [],
        }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("Career Quiz multiplayer scoreboard")).not.toBeInTheDocument();
  });

  it("renders the Career Quick Match searching lobby and cancels the search", async () => {
    const onNewGame = vi.fn();
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({
          status: "waiting_for_opponent",
          join_code: null,
          is_public: true,
          preset: "standard",
          current_round: null,
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={onNewGame}
      />
    );

    expect(screen.getByText("SEARCHING THE POOL…")).toBeInTheDocument();
    expect(screen.getByText("First to 3")).toBeInTheDocument();
    // Public quick-match games hide the join code, so no invite link must leak.
    expect(screen.queryByText("Copy link")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Cancel search"));

    await waitFor(() => expect(cancelCareerQuickMatch).toHaveBeenCalledWith({
      preset: "standard",
      game_id: 7,
    }));
    expect(onNewGame).toHaveBeenCalled();
  });

  it("shows a shareable invite link in the private friend waiting lobby", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({
          status: "waiting_for_opponent",
          current_round: null,
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const inviteUrl = buildInviteUrl("ABC123", "/career");
    expect(inviteUrl).toContain("/career?join=ABC123");
    expect(screen.getByText("ABC123")).toBeInTheDocument();
    expect(screen.getByText(inviteUrl)).toBeInTheDocument();
    expect(screen.getByText("Copy link")).toBeInTheDocument();
  });

  it("shows a display-only 20s countdown in the shared scoreboard for public Quick Match active rounds", async () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({
          is_public: true,
          preset: "standard",
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const timer = await screen.findByRole("timer");
    expect(timer).toHaveTextContent("20");
    expect(timer).toHaveAttribute("aria-label", "20 seconds left");
    // The countdown lives inside the shared OnlineScoreboard, consistent with
    // TicTacToe and Guess the List Race rather than a separate pill.
    const scoreboard = screen.getByRole("group", {
      name: "Career Quiz multiplayer scoreboard",
    });
    expect(within(scoreboard).getByRole("timer")).toBe(timer);
    // The standalone "Time's up" affordance stays hidden during the countdown.
    expect(screen.queryByTestId("career-round-timer")).not.toBeInTheDocument();
  });

  it("counts the scoreboard timer down to zero and reveals the auto-skip affordance at expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T16:00:00Z"));
    getCareerGame.mockResolvedValue(
      activeCareerGame({ is_public: true, preset: "standard" })
    );

    render(
      <CareerQuizBoard
        initialState={activeCareerGame({ is_public: true, preset: "standard" })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByRole("timer")).toHaveTextContent("20");
    expect(screen.queryByTestId("career-round-timer")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(21000);
    });

    expect(screen.getByRole("timer")).toHaveTextContent("0");
    expect(screen.getByTestId("career-round-timer")).toHaveTextContent("Time's up");
  });

  it("hides cooperative no-answer controls in public Quick Match games", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({
          is_public: true,
          preset: "standard",
          pending_no_answer_to: 1,
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByText("Accept no answer")).not.toBeInTheDocument();
    expect(screen.queryByText("Decline")).not.toBeInTheDocument();
    expect(screen.queryByText("Nobody knows")).not.toBeInTheDocument();
  });

  it("does not show Player 2 as the winner when an unattended public game has no winner", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({
          status: "finished",
          is_public: true,
          preset: "standard",
          winner_player: null,
          current_round: null,
          latest_completed_round: completedRound({
            round_number: 1,
            name: "Skipped Player",
            status: "no_answer",
            winner_player: null,
          }),
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "No winner" })).toBeInTheDocument();
    expect(screen.queryByText("B wins!")).not.toBeInTheDocument();
  });

  it("renders shared wrong guesses for the active round", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({
          wrong_guess_visibility: "shared",
          current_round: {
            ...activeCareerGame().current_round,
            wrong_guesses: [
              {
                player_number: 1,
                player: { id: 10, name: "Wrong One", image_url: null },
              },
              {
                player_number: 2,
                player: { id: 11, name: "Wrong Two", image_url: null },
              },
            ],
          },
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const wrongGuesses = within(screen.getByLabelText("Shared wrong guesses"));
    expect(wrongGuesses.getByText("A")).toBeInTheDocument();
    expect(wrongGuesses.getByText("B")).toBeInTheDocument();
    expect(wrongGuesses.getByText("Wrong One")).toBeInTheDocument();
    expect(wrongGuesses.getByText("Wrong Two")).toBeInTheDocument();
  });

  it("renders no shared wrong guesses when the field is absent", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByLabelText("Shared wrong guesses")).not.toBeInTheDocument();
  });

  it("styles multiplayer correct and wrong guess feedback with distinct tones", async () => {
    autocompleteCareerPlayer
      .mockResolvedValueOnce({ players: [{ id: 41, name: "Wrong Player" }] })
      .mockResolvedValueOnce({ players: [{ id: 42, name: "Winning Player" }] });

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectCareerPlayer("Wrong Player");
    expect(lastCareerRealtimeConnection().sent).toContainEqual({
      action: "guess",
      player_id: 41,
      round_number: 1,
    });
    emitCareerRealtimeState({
      state: activeCareerGame(),
      result: "incorrect",
    });

    const wrongFeedback = await screen.findByTestId("career-feedback-message");
    expect(wrongFeedback).toHaveTextContent("Wrong guess.");
    expect(wrongFeedback).toHaveClass("bg-red-50", "text-red-600");
    expect(wrongFeedback).not.toHaveClass("bg-emerald-50");

    await selectCareerPlayer("Winning Player");
    expect(lastCareerRealtimeConnection().sent).toContainEqual({
      action: "guess",
      player_id: 42,
      round_number: 1,
    });
    emitCareerRealtimeState({
      state: activeCareerGame({
        round_number: 2,
        current_round: {
          ...activeCareerGame().current_round,
          round_number: 2,
        },
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

    const successFeedback = await screen.findByTestId("career-feedback-message");
    expect(successFeedback).toHaveTextContent("Correct!");
    expect(successFeedback).toHaveClass("bg-emerald-50", "text-emerald-700");
    expect(successFeedback).not.toHaveClass("bg-red-50");
  });

  it("does not show personal correct feedback for an opponent win broadcast", () => {
    const wonRound = completedRound({
      round_number: 1,
      name: "Opponent Winner",
      status: "completed",
      winner_player: 1,
    });
    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    emitCareerRealtimeState({
      state: activeCareerGame({
        round_number: 2,
        current_round: {
          ...activeCareerGame().current_round,
          round_number: 2,
        },
        latest_completed_round: wonRound,
      }),
      result: "round_won",
      completedRound: wonRound,
    });

    expect(screen.queryByText("Correct!")).not.toBeInTheDocument();
  });

  it("clears stale personal feedback when an opponent wins the round", () => {
    const wonRound = completedRound({
      round_number: 1,
      name: "Opponent Winner",
      status: "completed",
      winner_player: 1,
    });
    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    emitCareerRealtimeState({
      state: activeCareerGame(),
      result: "incorrect",
    });
    expect(screen.getByText("Wrong guess.")).toBeInTheDocument();

    emitCareerRealtimeState({
      state: activeCareerGame({
        round_number: 2,
        current_round: {
          ...activeCareerGame().current_round,
          round_number: 2,
        },
        latest_completed_round: wonRound,
      }),
      result: "round_won",
      completedRound: wonRound,
    });

    expect(screen.queryByText("Wrong guess.")).not.toBeInTheDocument();
    expect(screen.queryByText("Correct!")).not.toBeInTheDocument();
  });

  it("does not show personal wrong feedback for an opponent shared wrong-guess broadcast", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({ wrong_guess_visibility: "shared" })}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    emitCareerRealtimeState({
      state: activeCareerGame({
        wrong_guess_visibility: "shared",
        current_round: {
          ...activeCareerGame().current_round,
          wrong_guesses: [
            {
              player_number: 1,
              player: { id: 10, name: "Opponent Miss", image_url: null },
            },
          ],
        },
      }),
      result: "incorrect",
    });

    expect(screen.queryByText("Wrong guess.")).not.toBeInTheDocument();
    expect(screen.getByText("Opponent Miss")).toBeInTheDocument();
  });

  it("keeps a sent no-answer offer message during an opponent shared wrong-guess broadcast", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({ wrong_guess_visibility: "shared" })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    emitCareerRealtimeState({
      state: activeCareerGame({
        wrong_guess_visibility: "shared",
        pending_no_answer_from: 1,
        pending_no_answer_to: 2,
      }),
      result: "no_answer_offered",
    });
    expect(screen.getByText("No-answer offer sent.")).toBeInTheDocument();

    emitCareerRealtimeState({
      state: activeCareerGame({
        wrong_guess_visibility: "shared",
        pending_no_answer_from: 1,
        pending_no_answer_to: 2,
        current_round: {
          ...activeCareerGame().current_round,
          wrong_guesses: [
            {
              player_number: 2,
              player: { id: 10, name: "Opponent Miss", image_url: null },
            },
          ],
        },
      }),
      result: "incorrect",
    });

    expect(screen.getByText("No-answer offer sent.")).toBeInTheDocument();
    expect(screen.queryByText("Wrong guess.")).not.toBeInTheDocument();
    expect(screen.getByText("Opponent Miss")).toBeInTheDocument();
  });

  it("clears stale personal feedback after a result-less realtime resync", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    emitCareerRealtimeState({
      state: activeCareerGame(),
      result: "incorrect",
    });
    expect(screen.getByText("Wrong guess.")).toBeInTheDocument();

    emitCareerRealtimeState({
      state: activeCareerGame({
        round_number: 2,
        current_round: {
          ...activeCareerGame().current_round,
          round_number: 2,
        },
      }),
    });

    expect(screen.queryByText("Wrong guess.")).not.toBeInTheDocument();
  });

  it("keeps a sent no-answer offer message after a result-less pending-offer resync", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    emitCareerRealtimeState({
      state: activeCareerGame({
        pending_no_answer_from: 1,
        pending_no_answer_to: 2,
      }),
      result: "no_answer_offered",
    });
    expect(screen.getByText("No-answer offer sent.")).toBeInTheDocument();

    emitCareerRealtimeState({
      state: activeCareerGame({
        pending_no_answer_from: 1,
        pending_no_answer_to: 2,
      }),
    });

    expect(screen.getByText("No-answer offer sent.")).toBeInTheDocument();
  });

  it("uses the same feedback tones in solo mode", async () => {
    autocompleteCareerPlayer
      .mockResolvedValueOnce({ players: [{ id: 51, name: "Solo Miss" }] })
      .mockResolvedValueOnce({ players: [{ id: 52, name: "Solo Hit" }] });
    submitCareerSoloGuess
      .mockResolvedValueOnce({ correct: false })
      .mockResolvedValueOnce({
        correct: true,
        answer: careerAnswer({ id: 52, name: "Solo Hit" }),
      });

    render(
      <CareerQuizBoard
        soloInitialRound={soloCareerRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await selectCareerPlayer("Solo Miss");

    const wrongFeedback = await screen.findByTestId("career-feedback-message");
    expect(wrongFeedback).toHaveTextContent("Not this player. Keep guessing.");
    expect(wrongFeedback).toHaveClass("bg-red-50", "text-red-600");

    await selectCareerPlayer("Solo Hit");

    const successFeedback = await screen.findByTestId("career-feedback-message");
    expect(successFeedback).toHaveTextContent("Correct!");
    expect(successFeedback).toHaveClass("bg-emerald-50", "text-emerald-700");
  });

  it("reveals solo hints progressively and stops at the hidden-letter cap", async () => {
    fetchCareerSoloHint
      .mockResolvedValueOnce({ type: "nationality", nationality: "Serbia", country_code: "RS" })
      .mockResolvedValueOnce({ type: "position", position: "Guard" })
      .mockResolvedValueOnce({
        type: "name_skeleton",
        skeleton: soloNameSkeleton(),
      })
      .mockResolvedValueOnce({ type: "letter_reveal", letter: "o", positions: [1, 3] })
      .mockResolvedValueOnce({ type: "exhausted" });

    render(
      <CareerQuizBoard
        soloInitialRound={soloCareerRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const revealButton = screen.getByRole("button", { name: "Reveal a hint" });
    expect(screen.getByText("Hints used: 0")).toBeInTheDocument();

    fireEvent.click(revealButton);
    expect(await screen.findByText("Serbia")).toBeInTheDocument();
    expect(screen.getByText("Hints used: 1")).toBeInTheDocument();

    fireEvent.click(revealButton);
    expect(await screen.findByText("Guard")).toBeInTheDocument();
    expect(screen.getByText("Hints used: 2")).toBeInTheDocument();

    fireEvent.click(revealButton);
    const maskedName = await screen.findByTestId("career-hint-masked-name");
    expect(maskedName).toHaveTextContent("____ ___");
    expect(screen.getByText("Hints used: 3")).toBeInTheDocument();

    fireEvent.click(revealButton);
    await waitFor(() => expect(maskedName).toHaveTextContent("_O_O ___"));
    expect(screen.getByText("Hints used: 4")).toBeInTheDocument();

    fireEvent.click(revealButton);
    await waitFor(() => expect(revealButton).toHaveTextContent("No more hints"));
    expect(revealButton).toBeDisabled();
    expect(screen.getByText("Hints used: 4")).toBeInTheDocument();

    expect(fetchCareerSoloHint).toHaveBeenNthCalledWith(1, "solo-round", {
      shown_hints: [],
      revealed_letters: [],
    });
    expect(fetchCareerSoloHint).toHaveBeenNthCalledWith(4, "solo-round", {
      shown_hints: ["nationality", "position", "name_skeleton"],
      revealed_letters: [],
    });
    expect(fetchCareerSoloHint).toHaveBeenNthCalledWith(5, "solo-round", {
      shown_hints: ["nationality", "position", "name_skeleton"],
      revealed_letters: ["o"],
    });
  });

  it("resets solo hints when advancing to the next solo round", async () => {
    fetchCareerSoloHint.mockResolvedValueOnce({ type: "nationality", nationality: "Spain" });
    autocompleteCareerPlayer.mockResolvedValueOnce({ players: [{ id: 52, name: "Solo Hit" }] });
    submitCareerSoloGuess.mockResolvedValueOnce({
      correct: true,
      answer: careerAnswer({ id: 52, name: "Solo Hit" }),
    });
    createCareerSoloRound.mockResolvedValueOnce(soloCareerRound({ round_token: "next-round" }));

    render(
      <CareerQuizBoard
        soloInitialRound={soloCareerRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Reveal a hint" }));
    expect(await screen.findByText("Spain")).toBeInTheDocument();
    expect(screen.getByText("Hints used: 1")).toBeInTheDocument();

    await selectCareerPlayer("Solo Hit");
    fireEvent.click(screen.getByRole("button", { name: "Next career" }));

    await waitFor(() => expect(createCareerSoloRound).toHaveBeenCalledWith([52]));
    // The hint reset runs in nextSoloRound's continuation after createCareerSoloRound
    // resolves, so wait for the revealed hint to actually clear instead of racing it.
    await waitFor(() => expect(screen.queryByText("Spain")).not.toBeInTheDocument());
    expect(screen.getByText("Hints used: 0")).toBeInTheDocument();
  });

  it("ignores stale hint responses after advancing to a new solo round", async () => {
    let resolveHint;
    fetchCareerSoloHint.mockReturnValueOnce(new Promise((resolve) => {
      resolveHint = resolve;
    }));
    autocompleteCareerPlayer.mockResolvedValueOnce({ players: [{ id: 52, name: "Solo Hit" }] });
    submitCareerSoloGuess.mockResolvedValueOnce({
      correct: true,
      answer: careerAnswer({ id: 52, name: "Solo Hit" }),
    });
    createCareerSoloRound.mockResolvedValueOnce(soloCareerRound({ round_token: "next-round" }));

    render(
      <CareerQuizBoard
        soloInitialRound={soloCareerRound()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Reveal a hint" }));
    expect(await screen.findByRole("button", { name: "Loading hint..." })).toBeDisabled();

    await selectCareerPlayer("Solo Hit");
    fireEvent.click(screen.getByRole("button", { name: "Next career" }));
    await waitFor(() => expect(createCareerSoloRound).toHaveBeenCalledWith([52]));

    await act(async () => {
      resolveHint({ type: "nationality", nationality: "Stale Country" });
    });

    expect(screen.queryByText("Stale Country")).not.toBeInTheDocument();
    expect(screen.getByText("Hints used: 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reveal a hint" })).toBeEnabled();
  });

  it("does not show solo hints in multiplayer", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByTestId("career-solo-hints")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal a hint" })).not.toBeInTheDocument();
  });

  it("shows a polled latest completed round once for a non-acting player", async () => {
    vi.useFakeTimers();
    getCareerGame.mockResolvedValue(
      activeCareerGame({
        latest_completed_round: completedRound({ round_number: 1, name: "Polled Answer" }),
      })
    );

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
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

  it("shows the answer player image during a multiplayer completed-round reveal", async () => {
    vi.useFakeTimers();
    const imageUrl = "https://example.com/players/polled-answer.png";
    getCareerGame.mockResolvedValue(
      activeCareerGame({
        latest_completed_round: completedRound({
          round_number: 1,
          name: "Image Answer",
          image_url: imageUrl,
        }),
      })
    );

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    const image = screen.getByRole("img", { name: "Image Answer" });
    expect(image).toHaveAttribute("src", imageUrl);
    expect(image).toHaveClass("w-20", "h-20", "rounded-full", "object-cover", "object-top");
    expect(screen.getByText("Answer: Image Answer")).toBeInTheDocument();
  });

  it("omits the multiplayer completed-round image when the answer has no image URL", async () => {
    vi.useFakeTimers();
    getCareerGame.mockResolvedValue(
      activeCareerGame({
        latest_completed_round: completedRound({ round_number: 1, name: "No Photo Answer" }),
      })
    );

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(screen.getByText("Answer: No Photo Answer")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "No Photo Answer" })).not.toBeInTheDocument();
  });

  it("rewrites a EuroLeague CDN answer image to a width-bounded webp", async () => {
    vi.useFakeTimers();
    const cdn = "https://media-cdn.incrowdsports.com/answer-xyz.png";
    getCareerGame.mockResolvedValue(
      activeCareerGame({
        latest_completed_round: completedRound({
          round_number: 1,
          name: "CDN Answer",
          image_url: cdn,
        }),
      })
    );

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    const image = screen.getByRole("img", { name: "CDN Answer" });
    expect(image).toHaveAttribute("src", `${cdn}?width=256&format=webp`);
  });

  it("does not replay an initial latest completed round on refresh", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({
          latest_completed_round: completedRound({ round_number: 1, name: "Already Seen" }),
        })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByText("Answer: Already Seen")).not.toBeInTheDocument();
  });

  it("shows a server-anchored countdown and disables guessing while locked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T15:59:50Z"));
    getCareerGame.mockResolvedValue(
      activeCareerGame({
        latest_completed_round: completedRound({
          round_number: 1,
          name: "Timed Answer",
          next_round_starts_at: "2026-06-15T16:00:03+00:00",
        }),
      })
    );

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
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
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByText("Next round unlocks in 2")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByPlaceholderText("Type a player name...")).not.toBeDisabled();
    expect(
      getRevealCountdownRemaining(
        "2026-06-15T16:00:03+00:00",
        Date.parse("2026-06-15T16:00:03Z")
      )
    ).toBe(0);
  });

  it("ignores locked guess conflicts without showing an error", async () => {
    autocompleteCareerPlayer.mockResolvedValue({
      players: [{ id: 99, name: "Locked Player" }],
    });
    submitCareerGuess.mockRejectedValue(
      Object.assign(new Error("round_locked"), {
        status: 409,
        detail: "round_locked",
      })
    );

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Type a player name..."), {
      target: { value: "locked" },
    });

    await waitFor(() => expect(screen.getByText("Locked Player")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Locked Player"));

    await waitFor(() => expect(submitCareerGuess).toHaveBeenCalledWith(7, 1, 99, 1));
    expect(screen.queryByText("round_locked")).not.toBeInTheDocument();
  });

  it("resyncs silently when a stale round guess is rejected", async () => {
    autocompleteCareerPlayer.mockResolvedValue({
      players: [{ id: 99, name: "Stale Player" }],
    });
    submitCareerGuess.mockRejectedValue(
      Object.assign(new Error("round_stale"), {
        status: 409,
        detail: "round_stale",
      })
    );
    getCareerGame.mockResolvedValue(activeCareerGame({
      round_number: 2,
      current_round: {
        ...activeCareerGame().current_round,
        round_number: 2,
      },
    }));

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Type a player name..."), {
      target: { value: "stale" },
    });

    await waitFor(() => expect(screen.getByText("Stale Player")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Stale Player"));

    await waitFor(() => expect(submitCareerGuess).toHaveBeenCalledWith(7, 1, 99, 1));
    await waitFor(() => expect(getCareerGame).toHaveBeenCalledWith(7));
    expect(screen.queryByText("round_stale")).not.toBeInTheDocument();
  });

  it("clears a sent no-answer offer message when polling shows the round advanced", async () => {
    vi.useFakeTimers();
    getCareerGame.mockResolvedValue(activeCareerGame({
      round_number: 2,
      current_round: {
        ...activeCareerGame().current_round,
        round_number: 2,
      },
      latest_completed_round: completedRound({ round_number: 1, name: "Opponent Answer" }),
    }));

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Nobody knows"));
    });

    expect(lastCareerRealtimeConnection().sent).toContainEqual({
      action: "offer_no_answer",
      round_number: 1,
    });
    emitCareerRealtimeState({
      state: activeCareerGame({
        pending_no_answer_from: 1,
        pending_no_answer_to: 2,
      }),
      result: "no_answer_offered",
    });
    expect(screen.getByText("No-answer offer sent.")).toBeInTheDocument();
    expect(screen.getByTestId("career-feedback-message")).toHaveClass("bg-amber-50", "text-amber-700");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(getCareerGame).toHaveBeenCalledWith(7);
    expect(screen.queryByText("No-answer offer sent.")).not.toBeInTheDocument();
  });
});

describe("CareerQuizBoard search keyboard submit", () => {
  it("submits the only career search result when Enter is pressed", async () => {
    autocompleteCareerPlayer.mockResolvedValue({
      players: [{ id: 77, name: "Only Match" }],
    });
    submitCareerGuess.mockResolvedValue({
      state: activeCareerGame(),
      result: "incorrect",
    });

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Type a player name...");
    fireEvent.change(input, { target: { value: "only" } });

    await screen.findByRole("button", { name: "Only Match" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(submitCareerGuess).toHaveBeenCalledWith(7, 1, 77, 1));
  });

  it("does not submit career search when Enter is pressed with no results", async () => {
    autocompleteCareerPlayer.mockResolvedValue({ players: [] });

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Type a player name...");
    fireEvent.change(input, { target: { value: "none" } });

    await waitFor(() => expect(autocompleteCareerPlayer).toHaveBeenCalledWith("none"));
    fireEvent.keyDown(input, { key: "Enter" });

    expect(submitCareerGuess).not.toHaveBeenCalled();
  });

  it("does not submit career search when Enter is pressed with multiple results", async () => {
    autocompleteCareerPlayer.mockResolvedValue({
      players: [
        { id: 78, name: "First Match" },
        { id: 79, name: "Second Match" },
      ],
    });

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
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

    expect(submitCareerGuess).not.toHaveBeenCalled();
  });

  it("highlights with ArrowDown and submits the highlighted career result on Enter", async () => {
    autocompleteCareerPlayer.mockResolvedValue({
      players: [
        { id: 78, name: "First Match" },
        { id: 79, name: "Second Match" },
      ],
    });
    submitCareerGuess.mockResolvedValue({
      state: activeCareerGame(),
      result: "incorrect",
    });

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
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

    await waitFor(() => expect(submitCareerGuess).toHaveBeenCalledWith(7, 1, 79, 1));
  });

  it("clears the guess box query and autocomplete results when the online round changes", async () => {
    autocompleteCareerPlayer.mockResolvedValue({
      players: [{ id: 81, name: "Stale Match" }],
    });

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Type a player name...");
    fireEvent.change(input, { target: { value: "stale" } });
    await screen.findByRole("button", { name: "Stale Match" });
    expect(input).toHaveValue("stale");

    emitCareerRealtimeState({
      state: activeCareerGame({
        round_number: 2,
        current_round: {
          ...activeCareerGame().current_round,
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
    autocompleteCareerPlayer.mockResolvedValue({
      players: [{ id: 82, name: "Same Round Match" }],
    });

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    const input = screen.getByPlaceholderText("Type a player name...");
    fireEvent.change(input, { target: { value: "same" } });
    await screen.findByRole("button", { name: "Same Round Match" });

    emitCareerRealtimeState({ state: activeCareerGame() });

    expect(input).toHaveValue("same");
    expect(screen.getByRole("button", { name: "Same Round Match" })).toBeInTheDocument();
  });
});

describe("CareerQuizBoard online resign", () => {
  it("resigns through the give-up endpoint and shows the self-resign outcome", async () => {
    resignCareerGame.mockResolvedValue({
      state: activeCareerGame({ status: "finished", winner_player: 2 }),
      result: "resigned",
    });

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    // First click reveals the confirm card, second click confirms the resign.
    fireEvent.click(screen.getByText("Resign"));
    expect(
      screen.getByText("Resign the match? Your opponent wins.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Resign"));

    await waitFor(() => expect(resignCareerGame).toHaveBeenCalledWith(7, 1));
    expect(await screen.findByText("You resigned.")).toBeInTheDocument();
  });

  it("renders an opponent resignation delivered over realtime", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
        onlineInfo={{ playerNumber: 2 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    // Player 1 resigned remotely, so player 2 wins and must see the
    // opponent-perspective note instead of the self-resign copy.
    emitCareerRealtimeState({
      state: activeCareerGame({ status: "finished", winner_player: 2 }),
      result: "resigned",
    });

    expect(screen.getByText("Your opponent resigned.")).toBeInTheDocument();
  });

  it("does not offer a resign control once the game is finished", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({ status: "finished", winner_player: 2 })}
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    expect(screen.queryByText("Resign")).not.toBeInTheDocument();
  });

  it("hides the resign control during the inter-round reveal lock", () => {
    render(
      <CareerQuizBoard
        initialState={activeCareerGame({
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

function activeCareerGame(overrides = {}) {
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
    current_round: {
      round_number: 1,
      status: "active",
      winner_player: null,
      timeline: [
        {
          team_name: "Team 1",
          start_season: "2020/21",
          end_season: "2020/21",
        },
      ],
      resolved_at: null,
    },
    latest_completed_round: null,
    ...overrides,
  };
}

function soloCareerRound(overrides = {}) {
  return {
    round_token: "solo-round",
    timeline: [
      {
        team_name: "Solo Team",
        start_season: "2020/21",
        end_season: "2020/21",
      },
    ],
    ...overrides,
  };
}

function soloNameSkeleton() {
  return [
    { kind: "hidden_letter", index: 0 },
    { kind: "hidden_letter", index: 1 },
    { kind: "hidden_letter", index: 2 },
    { kind: "hidden_letter", index: 3 },
    { kind: "space", index: 4, value: " " },
    { kind: "hidden_letter", index: 5 },
    { kind: "hidden_letter", index: 6 },
    { kind: "hidden_letter", index: 7 },
  ];
}

function careerAnswer({ id, name }) {
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

async function selectCareerPlayer(name) {
  fireEvent.change(screen.getByPlaceholderText("Type a player name..."), {
    target: { value: name },
  });
  const option = await screen.findByRole("button", { name });
  await act(async () => {
    fireEvent.click(option);
  });
}

function lastCareerRealtimeConnection() {
  return careerRealtimeConnections[careerRealtimeConnections.length - 1];
}

function emitCareerRealtimeState({ state, result = null, completedRound = null }) {
  act(() => {
    lastCareerRealtimeConnection().emit({
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

describe("CareerQuizBoard header navigation", () => {
  it("exposes a single consistent Home control that returns to the app home", () => {
    const onHome = vi.fn();
    const onNewGame = vi.fn();

    render(
      <CareerQuizBoard
        initialState={activeCareerGame()}
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
