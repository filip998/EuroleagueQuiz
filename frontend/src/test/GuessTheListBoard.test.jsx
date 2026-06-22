import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../api", () => ({
  getGuessTheListGame: vi.fn(),
  submitGuessTheList: vi.fn(),
  offerEndRound: vi.fn(),
  respondEndRound: vi.fn(),
  connectGuessTheListRealtime: vi.fn(),
  autocompleteGuessTheListPlayer: vi.fn(),
  giveUpGuessTheListRound: vi.fn(),
}));

const realtimeHolder = vi.hoisted(() => ({ opts: null, sendAction: vi.fn() }));
vi.mock("../useOnlineGameRealtime", () => ({
  useOnlineGameRealtime: (opts) => {
    realtimeHolder.opts = opts;
    return { sendAction: realtimeHolder.sendAction };
  },
}));

vi.mock("../ClubLogo", () => ({
  default: ({ code }) => <span data-testid="club-logo">{code}</span>,
}));

import GuessTheListBoard from "../GuessTheListBoard";
import { offerEndRound, respondEndRound } from "../api";

beforeEach(() => {
  vi.clearAllMocks();
  realtimeHolder.opts = null;
  realtimeHolder.sendAction = vi.fn(() => true);
});

function activeSoloGame(overrides = {}) {
  return {
    id: 1,
    mode: "single_player",
    status: "active",
    player1_name: "Solo",
    player1_score: 0,
    player2_score: 0,
    current_player: 1,
    round_number: 1,
    target_wins: 3,
    turn_seconds: null,
    round: {
      status: "in_progress",
      team_code: "MAD",
      team_name: "Real Madrid",
      season_year: 2020,
      guessed_count: 0,
      total_slots: 1,
      slots: [{ id: 1, position: "Guard", guessed_by_player: null }],
    },
    ...overrides,
  };
}

function onlineClassicGame(overrides = {}) {
  const baseRound = {
    status: "in_progress",
    team_code: "MAD",
    team_name: "Real Madrid",
    season_year: 2020,
    guessed_count: 0,
    total_slots: 1,
    slots: [{ id: 1, position: "Guard", guessed_by_player: null }],
  };

  return activeSoloGame({
    id: 99,
    mode: "online_friend",
    status: "active",
    player1_name: "Alice",
    player2_name: "Bob",
    player1_score: 0,
    player2_score: 0,
    current_player: 1,
    target_wins: 2,
    pending_end: null,
    ...overrides,
    round: {
      ...baseRound,
      ...(overrides.round || {}),
    },
  });
}

function getSpanByTextContent(text) {
  return screen.getByText((_, element) =>
    element?.tagName?.toLowerCase() === "span" && element.textContent.includes(text)
  );
}

describe("GuessTheListBoard header navigation", () => {
  it("exposes a single consistent Home control that returns to the app home", () => {
    const onHome = vi.fn();
    const onNewGame = vi.fn();

    render(
      <GuessTheListBoard
        initialState={activeSoloGame()}
        onNewGame={onNewGame}
        onHome={onHome}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));

    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onNewGame).not.toHaveBeenCalled();
  });
});

describe("GuessTheListBoard end-of-game result", () => {
  it("does not credit Player 2 when a finished online game has no winner", () => {
    render(
      <GuessTheListBoard
        initialState={{
          id: 2,
          mode: "online_friend",
          status: "finished",
          player1_name: "Alice",
          player2_name: "Bob",
          player1_score: 1,
          player2_score: 1,
          current_player: 1,
          round_number: 2,
          target_wins: 2,
          turn_seconds: null,
          winner_player: null,
          round: {
            status: "completed",
            team_code: "MAD",
            team_name: "Real Madrid",
            season_year: 2020,
            guessed_count: 1,
            total_slots: 1,
            slots: [{ id: 1, position: "Guard", guessed_by_player: 1 }],
          },
        }}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    // A null winner must not fall through to the Player 2 name; the shared
    // winnerDisplayName helper renders a neutral "No winner" headline.
    expect(screen.getByRole("heading", { name: "No winner" })).toBeInTheDocument();
    expect(screen.queryByText("Bob WINS!")).not.toBeInTheDocument();
  });

  it("renders an opponent-left win delivered over realtime", async () => {
    render(
      <GuessTheListBoard
        initialState={onlineClassicGame({ current_player: 1 })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    act(() => {
      realtimeHolder.opts.onState({
        state: onlineClassicGame({
          status: "finished",
          winner_player: 2,
          round: {
            status: "completed",
            slots: [
              {
                id: 1,
                position: "Guard",
                guessed_by_player: null,
                player_name: "Hidden Player",
              },
            ],
          },
        }),
        result: "opponent_left",
      });
    });

    expect(await screen.findByText("Your opponent left the game.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bob WINS!" })).toBeInTheDocument();
  });
});

describe("GuessTheListBoard online pending end offers", () => {
  it.each([
    {
      label: "Player 1 to Player 2",
      pendingEnd: { offered_by: 1, respond_to: 2 },
      currentPlayer: 2,
      viewer: "2",
      offererName: "Alice",
    },
    {
      label: "Player 2 to Player 1",
      pendingEnd: { offered_by: 2, respond_to: 1 },
      currentPlayer: 1,
      viewer: 1,
      offererName: "Bob",
    },
  ])("shows enabled recipient controls for $label", ({ pendingEnd, currentPlayer, viewer, offererName }) => {
    render(
      <GuessTheListBoard
        initialState={onlineClassicGame({ current_player: currentPlayer, pending_end: pendingEnd })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: viewer }}
      />
    );

    expect(getSpanByTextContent(`${offererName} wants to end.`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
    expect(screen.queryByPlaceholderText("Type a player name to guess...")).not.toBeInTheDocument();
  });

  it("shows a waiting state without response controls to the sender", () => {
    render(
      <GuessTheListBoard
        initialState={onlineClassicGame({
          current_player: 2,
          pending_end: { offered_by: 1, respond_to: 2 },
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    expect(getSpanByTextContent("Waiting for Bob to respond.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
  });

  it("declines via HTTP fallback during websocket reconnect and restores recipient guessing", async () => {
    realtimeHolder.sendAction = vi.fn(() => false);
    respondEndRound.mockResolvedValue({
      state: onlineClassicGame({ current_player: 2, pending_end: null }),
      result: "end_declined",
    });

    render(
      <GuessTheListBoard
        initialState={onlineClassicGame({
          current_player: 2,
          pending_end: { offered_by: 1, respond_to: 2 },
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() => expect(respondEndRound).toHaveBeenCalledWith(99, false, 2));
    expect(await screen.findByPlaceholderText("Type a player name to guess...")).toBeInTheDocument();
    expect(screen.queryByText(/wants to end/)).not.toBeInTheDocument();
  });

  it("offers via HTTP fallback with the online player when websocket is reconnecting", async () => {
    realtimeHolder.sendAction = vi.fn(() => false);
    offerEndRound.mockResolvedValue({
      state: onlineClassicGame({
        current_player: 2,
        pending_end: { offered_by: 1, respond_to: 2 },
      }),
      result: "end_offered",
    });

    render(
      <GuessTheListBoard
        initialState={onlineClassicGame({ current_player: 1 })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "End Round" }));

    await waitFor(() => expect(offerEndRound).toHaveBeenCalledWith(99, 1));
    expect(getSpanByTextContent("Waiting for Bob to respond.")).toBeInTheDocument();
  });

  it("does not expose broken controls when an online seat is missing", () => {
    render(
      <GuessTheListBoard
        initialState={onlineClassicGame({
          current_player: 2,
          pending_end: { offered_by: 1, respond_to: 2 },
        })}
        onNewGame={() => {}}
        onHome={() => {}}
      />
    );

    expect(screen.getByText(/online seat was not recovered/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Type a player name to guess...")).not.toBeInTheDocument();
  });
});

describe("GuessTheListBoard solo / local never goes online from a stale seat (issue #150)", () => {
  // A stale `elq_game_<id>` seat (from an earlier online game whose numeric id was
  // later reused by a brand-new solo/local game) can hand the board a truthy
  // `onlineInfo`. Mode must win: a non-online game stays offline.
  const staleSeat = { isOnline: true, playerNumber: 1 };

  it("hides the online seat banner for a single_player game with a stale seat", () => {
    render(
      <GuessTheListBoard
        initialState={activeSoloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={staleSeat}
      />
    );

    // The online-only "You are <name>" banner stays hidden; solo keeps Give Up.
    expect(screen.queryByText(/You are/)).not.toBeInTheDocument();
    expect(screen.getByText("Give Up")).toBeInTheDocument();
    // The leak is behavioural too: the realtime transport must stay disabled.
    expect(realtimeHolder.opts.enabled).toBe(false);
  });

  it("stays offline for a local_two_player game with a stale seat", () => {
    render(
      <GuessTheListBoard
        initialState={activeSoloGame({ mode: "local_two_player", player2_name: "Two" })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={staleSeat}
      />
    );

    expect(screen.queryByText(/You are/)).not.toBeInTheDocument();
    expect(realtimeHolder.opts.enabled).toBe(false);
  });
});

describe("GuessTheListBoard leaderboard rounds", () => {
  function allTimeSoloGame(overrides = {}) {
    return activeSoloGame({
      round: {
        status: "in_progress",
        category_type: "all_time",
        scope_label: "All-time points leaders (2000-2025)",
        team_code: null,
        team_name: null,
        season_year: null,
        guessed_count: 1,
        total_slots: 2,
        slots: [
          {
            id: 1,
            position: "Guard",
            nationality: "Spain",
            guessed_by_player: 1,
            player_name: "Sergio Llull",
            rank: 1,
            stat_value: 4812,
            stat_value_label: "4,812 pts",
          },
          {
            id: 2,
            position: null,
            nationality: null,
            guessed_by_player: null,
            player_name: null,
            // The backend nulls rank/stat until reveal; we send non-null values
            // here to prove the frontend itself still masks them for an
            // unclaimed slot (defense-in-depth, not trusting backend nulls).
            rank: 2,
            stat_value: 3500,
            stat_value_label: "3,500 pts",
          },
        ],
      },
      ...overrides,
    });
  }

  it("renders the scope label header and a claimed slot's rank and stat value", () => {
    render(
      <GuessTheListBoard initialState={allTimeSoloGame()} onNewGame={() => {}} onHome={() => {}} />
    );

    expect(screen.getByText("All-time points leaders (2000-2025)")).toBeInTheDocument();
    expect(screen.getByText("Sergio Llull")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("4,812 pts")).toBeInTheDocument();
    // Leaderboard rounds drop the team logo + season chrome.
    expect(screen.queryByTestId("club-logo")).not.toBeInTheDocument();
  });

  it("hides rank and stat value for an unclaimed leaderboard slot", () => {
    render(
      <GuessTheListBoard initialState={allTimeSoloGame()} onNewGame={() => {}} onHome={() => {}} />
    );

    // The hidden slot stays masked: no rank badge, no stat value leaked.
    expect(screen.getByText("???")).toBeInTheDocument();
    expect(screen.queryByText("#2")).not.toBeInTheDocument();
    expect(screen.queryByText("3,500 pts")).not.toBeInTheDocument();
  });
});

describe("GuessTheListBoard All-EuroLeague rounds", () => {
  function allEuroLeagueGame() {
    return activeSoloGame({
      round: {
        status: "in_progress",
        category_type: "all_euroleague",
        scope_label: "All-EuroLeague · 2024/25",
        team_code: null,
        team_name: null,
        season_year: 2024,
        guessed_count: 1,
        total_slots: 2,
        slots: [
          {
            id: 1,
            position: "Guard",
            nationality: "Greece",
            guessed_by_player: 1,
            player_name: "Dimitris Diamantidis",
            rank: 1,
            stat_value_label: "First Team",
          },
          {
            id: 2,
            position: null,
            nationality: null,
            guessed_by_player: null,
            player_name: null,
            rank: 2,
            stat_value_label: "Second Team",
          },
        ],
      },
    });
  }

  it("renders the scope label and revealed tier without team chrome", () => {
    render(
      <GuessTheListBoard initialState={allEuroLeagueGame()} onNewGame={() => {}} onHome={() => {}} />
    );

    expect(screen.getByText("All-EuroLeague · 2024/25")).toBeInTheDocument();
    expect(screen.getByText("Dimitris Diamantidis")).toBeInTheDocument();
    expect(screen.getByText("1st")).toBeInTheDocument();
    expect(screen.getByText("First Team")).toBeInTheDocument();
    expect(screen.queryByTestId("club-logo")).not.toBeInTheDocument();
  });

  it("hides unclaimed All-EuroLeague tier details", () => {
    render(
      <GuessTheListBoard initialState={allEuroLeagueGame()} onNewGame={() => {}} onHome={() => {}} />
    );

    expect(screen.getByText("???")).toBeInTheDocument();
    expect(screen.queryByText("2nd")).not.toBeInTheDocument();
    expect(screen.queryByText("Second Team")).not.toBeInTheDocument();
  });
});

describe("GuessTheListBoard award winner rounds", () => {
  function awardWinnersGame(overrides = {}) {
    return activeSoloGame({
      round: {
        status: "in_progress",
        category_type: "award_winners",
        metric: "regular_season_mvp",
        scope_label: "EuroLeague MVPs · 2013/14-2020/21",
        team_code: null,
        team_name: null,
        season_year: 2013,
        guessed_count: 1,
        total_slots: 2,
        slots: [
          {
            id: 1,
            position: "Guard",
            nationality: "United States",
            guessed_by_player: 1,
            player_name: "Repeat Winner",
            rank: 1,
            stat_value_label: "MVP: 2013/14, 2014/15",
          },
          {
            id: 2,
            position: null,
            nationality: null,
            guessed_by_player: null,
            player_name: null,
            rank: 2,
            stat_value_label: "MVP: 2020/21",
          },
        ],
      },
      ...overrides,
    });
  }

  it("renders the scope label and revealed MVP season details without team chrome", () => {
    render(
      <GuessTheListBoard initialState={awardWinnersGame()} onNewGame={() => {}} onHome={() => {}} />
    );

    expect(screen.getByText("EuroLeague MVPs · 2013/14-2020/21")).toBeInTheDocument();
    expect(screen.getByText("Repeat Winner")).toBeInTheDocument();
    expect(screen.getByText("MVP")).toBeInTheDocument();
    expect(screen.getByText("MVP: 2013/14, 2014/15")).toBeInTheDocument();
    expect(screen.queryByTestId("club-logo")).not.toBeInTheDocument();
  });

  it("hides unclaimed award season details", () => {
    render(
      <GuessTheListBoard initialState={awardWinnersGame()} onNewGame={() => {}} onHome={() => {}} />
    );

    expect(screen.getByText("???")).toBeInTheDocument();
    expect(screen.queryByText("MVP: 2020/21")).not.toBeInTheDocument();
  });

  it("uses an F4 badge for Final Four MVP rounds", () => {
    render(
      <GuessTheListBoard
        initialState={awardWinnersGame({
          round: {
            ...awardWinnersGame().round,
            metric: "final_four_mvp",
            scope_label: "Final Four MVPs · 2010/11-2020/21",
            slots: [
              {
                id: 1,
                position: "Guard",
                nationality: "Serbia",
                guessed_by_player: 1,
                player_name: "Final Star",
                rank: 1,
                stat_value_label: "F4 MVP: 2020/21",
              },
            ],
          },
        })}
        onNewGame={() => {}}
        onHome={() => {}}
      />
    );

    expect(screen.getByText("F4")).toBeInTheDocument();
    expect(screen.getByText("F4 MVP: 2020/21")).toBeInTheDocument();
  });
});

describe("GuessTheListBoard Champions rounds", () => {
  function championsGame() {
    return activeSoloGame({
      round: {
        status: "in_progress",
        category_type: "champions",
        scope_label: "Champions · 2024/25 · Fenerbahce Beko",
        team_code: "ULK",
        team_name: "Fenerbahce Beko",
        season_year: 2024,
        guessed_count: 1,
        total_slots: 2,
        slots: [
          {
            id: 1,
            jersey_number: "7",
            position: "Forward",
            nationality: "United States",
            guessed_by_player: 1,
            player_name: "Nigel Hayes-Davis",
          },
          {
            id: 2,
            jersey_number: "8",
            position: "Guard",
            nationality: "Greece",
            guessed_by_player: null,
            player_name: null,
          },
        ],
      },
    });
  }

  it("renders the Champions scope header with roster-style hidden hints", () => {
    render(
      <GuessTheListBoard initialState={championsGame()} onNewGame={() => {}} onHome={() => {}} />
    );

    expect(screen.getByText("Champions · 2024/25 · Fenerbahce Beko")).toBeInTheDocument();
    expect(screen.getByText("Nigel Hayes-Davis")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("???")).toBeInTheDocument();
    expect(screen.queryByText("Hidden Champion")).not.toBeInTheDocument();
    expect(screen.queryByTestId("club-logo")).not.toBeInTheDocument();
  });
});
