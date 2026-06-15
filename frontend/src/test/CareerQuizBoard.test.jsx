import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  autocompleteCareerPlayer: vi.fn(),
  createCareerSoloRound: vi.fn(),
  getCareerGame: vi.fn(),
  offerCareerNoAnswer: vi.fn(),
  revealCareerSoloAnswer: vi.fn(),
  respondCareerNoAnswer: vi.fn(),
  submitCareerGuess: vi.fn(),
  submitCareerSoloGuess: vi.fn(),
}));

import CareerQuizBoard, {
  formatSeasonRange,
  getRevealCountdownRemaining,
  shouldRevealCompletedRound,
} from "../CareerQuizBoard";
import { autocompleteCareerPlayer, getCareerGame, submitCareerGuess } from "../api";

beforeEach(() => {
  vi.clearAllMocks();
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
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("Answer: Polled Answer")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByText("Answer: Polled Answer")).not.toBeInTheDocument();
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
    vi.setSystemTime(new Date("2026-06-15T16:00:00Z"));
    getCareerGame.mockResolvedValue(
      activeCareerGame({
        latest_completed_round: completedRound({
          round_number: 1,
          name: "Timed Answer",
          next_round_starts_at: "2026-06-15T16:00:05+00:00",
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
      await vi.advanceTimersByTimeAsync(2000);
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
        "2026-06-15T16:00:05+00:00",
        Date.parse("2026-06-15T16:00:05Z")
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
        onlineInfo={{ playerNumber: 1 }}
        onHome={vi.fn()}
        onNewGame={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Type a player name..."), {
      target: { value: "locked" },
    });

    await waitFor(() => expect(screen.getByText("Locked Player")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Locked Player"));

    await waitFor(() => expect(submitCareerGuess).toHaveBeenCalledWith(7, 1, 99));
    expect(screen.queryByText("round_locked")).not.toBeInTheDocument();
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

function completedRound({ round_number, name, next_round_starts_at = null }) {
  return {
    round_number,
    status: "no_answer",
    winner_player: null,
    resolved_at: "2026-06-15T16:00:00+00:00",
    next_round_starts_at,
    answer: {
      id: round_number,
      name,
      first_name: name.split(" ")[0],
      last_name: name.split(" ")[1],
      nationality: null,
      position: null,
      image_url: null,
    },
  };
}
