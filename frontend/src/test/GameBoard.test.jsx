import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import GameBoard from "../GameBoard";
import { submitMove, giveUpGame, cancelQuickMatchTicTacToe } from "../api";
import { clearOnlineInfo } from "../onlineRecovery";
import { forgetQuickMatchSeat } from "../quickMatchSeats";
import { buildInviteUrl } from "../inviteLink";

// Capture the options GameBoard hands to the realtime hook so tests can drive
// server-pushed state (e.g. a disconnect forfeit) without a real WebSocket.
const realtimeHolder = vi.hoisted(() => ({ opts: null }));
const playerSearchHolder = vi.hoisted(() => ({ props: null }));
vi.mock("../useOnlineGameRealtime", () => ({
  useOnlineGameRealtime: (opts) => {
    realtimeHolder.opts = opts;
    return {};
  },
}));

vi.mock("../PlayerSearch", () => ({
  default: (props) => {
    playerSearchHolder.props = props;
    return (
      <div data-testid="player-search">
        <button
          type="button"
          onClick={() => props.onSelect({ player_id: 99, full_name: "Nando De Colo" })}
        >
          select-player
        </button>
      </div>
    );
  },
}));

vi.mock("../api", () => ({
  getGame: vi.fn(),
  submitMove: vi.fn(),
  offerDraw: vi.fn(),
  respondDraw: vi.fn(),
  giveUpGame: vi.fn(),
  cancelQuickMatchTicTacToe: vi.fn(),
  connectTicTacToeRealtime: vi.fn(),
}));

// Recovery cleanup on cancel is asserted via these spies; the real behaviour is
// covered in onlineRecovery.test.js / quickMatchSeats.test.js.
vi.mock("../onlineRecovery", () => ({ clearOnlineInfo: vi.fn() }));
vi.mock("../quickMatchSeats", () => ({ forgetQuickMatchSeat: vi.fn() }));

// Stubs that capture the props GameBoard hands to the two waiting screens.
vi.mock("../WaitingLobby", () => ({
  default: ({ joinCode, inviteUrl }) => (
    <div
      data-testid="waiting-lobby"
      data-join-code={joinCode}
      data-invite-url={inviteUrl}
    />
  ),
}));

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

const axis = (label) => ({ axis_type: "season", display_label: label });
const boardCells = () =>
  [0, 1, 2].flatMap((row_index) =>
    [0, 1, 2].map((col_index) => ({
      row_index,
      col_index,
      claimed_by_player: null,
      claimed_player_id: null,
      claimed_player_name: null,
    }))
  );

function activeGame(overrides = {}) {
  return {
    id: 7,
    status: "active",
    mode: "online_friend",
    is_public: false,
    preset: null,
    current_player: 1,
    player1_name: "Alice",
    player2_name: "Bob",
    player1_score: 0,
    player2_score: 0,
    winner_player: null,
    round_number: 1,
    target_wins: 3,
    turn_seconds: null,
    round: {
      columns: [axis("A"), axis("B"), axis("C")],
      rows: [axis("1"), axis("2"), axis("3")],
      cells: boardCells(),
    },
    ...overrides,
  };
}

function soloGame(overrides = {}) {
  return activeGame({
    mode: "single_player",
    player1_name: "Solo Ace",
    player2_name: "",
    current_player: 1,
    solo_progress: {
      claimed_cells: 0,
      total_cells: 9,
      strikes_used: 0,
      strikes_remaining: 3,
      strike_limit: 3,
      boards_won: 0,
    },
    ...overrides,
  });
}

function completedRound(overrides = {}) {
  return {
    columns: [axis("A"), axis("B"), axis("C")],
    rows: [axis("1"), axis("2"), axis("3")],
    status: "completed",
    winner_player: 1,
    cells: boardCells().map((cell) => ({
      ...cell,
      sample_answers: ["Vasilije Micic"],
    })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  realtimeHolder.opts = null;
  playerSearchHolder.props = null;
});

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

  it("shows the Quick Match searching lobby for a public preset game", () => {
    render(
      <GameBoard
        initialState={{
          id: 8,
          status: "waiting_for_opponent",
          is_public: true,
          preset: "blitz",
        }}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    expect(screen.getByTestId("searching-lobby")).toHaveAttribute("data-preset", "blitz");
    expect(screen.queryByTestId("waiting-lobby")).not.toBeInTheDocument();
  });

  it("cancels a quick match search via the cancel endpoint", async () => {
    cancelQuickMatchTicTacToe.mockResolvedValue({ state: { id: 8, status: "cancelled" } });
    const onNewGame = vi.fn();
    render(
      <GameBoard
        initialState={{
          id: 8,
          status: "waiting_for_opponent",
          is_public: true,
          preset: "blitz",
        }}
        onNewGame={onNewGame}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    fireEvent.click(screen.getByText("stub-cancel"));

    await waitFor(() =>
      expect(cancelQuickMatchTicTacToe).toHaveBeenCalledWith({
        preset: "blitz",
        game_id: 8,
      })
    );
    await waitFor(() => expect(onNewGame).toHaveBeenCalled());
    // The deleted waiting row frees its id for reuse, so recovery data for that
    // id must be dropped to avoid mis-seating a later game as the wrong player.
    expect(clearOnlineInfo).toHaveBeenCalledWith(8);
    expect(forgetQuickMatchSeat).toHaveBeenCalledWith(8);
  });

  it("keeps recovery data when a cancel fails (search already matched)", async () => {
    cancelQuickMatchTicTacToe.mockRejectedValue(new Error("already matched"));
    const onNewGame = vi.fn();
    render(
      <GameBoard
        initialState={{
          id: 8,
          status: "waiting_for_opponent",
          is_public: true,
          preset: "blitz",
        }}
        onNewGame={onNewGame}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    fireEvent.click(screen.getByText("stub-cancel"));

    await waitFor(() => expect(cancelQuickMatchTicTacToe).toHaveBeenCalled());
    // A rejected cancel means the game still exists (it just matched); staying on
    // the board lets the realtime hook flip it to active, so we must NOT discard
    // the recovery data that keeps this client seated correctly.
    expect(clearOnlineInfo).not.toHaveBeenCalled();
    expect(forgetQuickMatchSeat).not.toHaveBeenCalled();
    expect(onNewGame).not.toHaveBeenCalled();
  });
});

describe("GameBoard online resign", () => {
  it("resigns through the HTTP give-up endpoint and shows the self-resign outcome", async () => {
    // Player 1 resigns, so the backend awards the win to player 2 and the
    // resigning viewer (player 1) must see the "You resigned." subtitle.
    giveUpGame.mockResolvedValue({
      state: activeGame({ status: "finished", winner_player: 2 }),
      result: "resigned",
    });

    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    // First click reveals the confirm dialog, second click confirms.
    fireEvent.click(screen.getByText("Resign"));
    fireEvent.click(screen.getByText("Resign"));

    await waitFor(() => expect(giveUpGame).toHaveBeenCalledWith(7, 1));
    expect(await screen.findByText("You resigned.")).toBeInTheDocument();
  });

  it("renders an opponent resignation delivered over realtime", async () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    // The opponent (player 1) resigned remotely, so player 2 wins and sees the
    // opponent-perspective subtitle (the iWon branch).
    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: 2 }),
        result: "resigned",
      });
    });

    expect(await screen.findByText("Your opponent resigned.")).toBeInTheDocument();
  });

  it("renders a disconnect forfeit delivered over realtime", async () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    // The grace timer only fires once the opponent is already disconnected, so
    // the terminal `opponent_left` broadcast only ever reaches the still-connected
    // winner. Here player 2 wins because player 1 left.
    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: 2 }),
        result: "opponent_left",
      });
    });

    expect(await screen.findByText("Your opponent left the game.")).toBeInTheDocument();
    // The terminal banner is suppressed in favour of the finished-screen subtitle.
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
  });

  it("offers draw and resign together so neither control falls below the fold (issue #259)", () => {
    // The viewport-fit fix combines the online Offer Draw and Resign controls
    // into one wrapping row. On the viewer's turn both must remain present and
    // reachable; dropping or re-stacking either is what pushed row 3 / controls
    // below the fold at 1366x768.
    render(
      <GameBoard
        initialState={activeGame({ current_player: 1 })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    expect(screen.getByText("Offer Draw")).toBeInTheDocument();
    expect(screen.getByText("Resign")).toBeInTheDocument();
  });
});

describe("GameBoard wrong-guess feedback", () => {
  const feedback = {
    message:
      "Nando De Colo matched the row clue EuroLeague champion, but not the column clue Played with Tornike Shengelia.",
  };

  it("renders backend feedback under the local incorrect banner", async () => {
    submitMove.mockResolvedValue({
      state: activeGame({ mode: "local_two_player", current_player: 2 }),
      result: "incorrect",
      feedback,
    });

    render(
      <GameBoard
        initialState={activeGame({ mode: "local_two_player" })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    fireEvent.click(screen.getAllByText("+")[0]);
    fireEvent.click(screen.getByText("select-player"));

    await waitFor(() =>
      expect(submitMove).toHaveBeenCalledWith(7, {
        row_index: 0,
        col_index: 0,
        player_id: 99,
      })
    );
    expect(await screen.findByText("❌ Incorrect. Turn switches.")).toBeInTheDocument();
    expect(screen.getByText(feedback.message)).toBeInTheDocument();
  });

  it("keeps timed local feedback visible after the turn timer syncs", async () => {
    submitMove.mockResolvedValue({
      state: activeGame({ mode: "local_two_player", current_player: 2, turn_seconds: 40 }),
      result: "incorrect",
      feedback,
    });

    render(
      <GameBoard
        initialState={activeGame({ mode: "local_two_player", turn_seconds: 40 })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    fireEvent.click(screen.getAllByText("+")[0]);
    fireEvent.click(screen.getByText("select-player"));

    await waitFor(() =>
      expect(submitMove).toHaveBeenCalledWith(7, {
        row_index: 0,
        col_index: 0,
        player_id: 99,
      })
    );
    expect(await screen.findByText("❌ Incorrect. Turn switches.")).toBeInTheDocument();
    expect(screen.getByText(feedback.message)).toBeInTheDocument();
  });

  it("renders realtime feedback under the online incorrect banner", async () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ current_player: 2 }),
        result: "incorrect",
        feedback,
      });
    });

    expect(await screen.findByText("❌ Incorrect. Turn switches.")).toBeInTheDocument();
    expect(screen.getByText(feedback.message)).toBeInTheDocument();
  });

  it("keeps the legacy terse incorrect copy when feedback is absent", async () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ current_player: 2 }),
        result: "incorrect",
      });
    });

    expect(await screen.findByText("❌ Incorrect. Turn switches.")).toBeInTheDocument();
    expect(screen.queryByText(/matched EuroLeague champion/)).not.toBeInTheDocument();
  });
});

describe("GameBoard solo stakes", () => {
  it("shows live claimed-cell and strike progress in solo mode", () => {
    render(
      <GameBoard
        initialState={soloGame({
          solo_progress: {
            claimed_cells: 4,
            total_cells: 9,
            strikes_used: 1,
            strikes_remaining: 2,
            strike_limit: 3,
            boards_won: 1,
          },
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const progress = screen.getByLabelText("TicTacToe solo progress");
    expect(within(progress).getByText("Make three in a row")).toBeInTheDocument();
    expect(within(progress).getByText("Claimed")).toBeInTheDocument();
    expect(within(progress).getByText("4/9")).toBeInTheDocument();
    expect(within(progress).getByText("Strikes left")).toBeInTheDocument();
    expect(within(progress).getByText("2/3")).toBeInTheDocument();
    // The strike pips carry their meaning on an accessible label, not by shape.
    expect(
      within(progress).getByLabelText(/strikes used/i)
    ).toBeInTheDocument();
    // The pointless solo player name is gone from the scoreboard.
    expect(within(progress).queryByText("Solo Ace")).not.toBeInTheDocument();
    expect(screen.getByText("Boards won: 1")).toBeInTheDocument();
    expect(screen.getByText("Show answers")).toBeInTheDocument();
    expect(screen.queryByText("Give Up")).not.toBeInTheDocument();
  });

  it("shows strike feedback after a solo wrong answer", async () => {
    const feedback = { message: "Nando De Colo did not match either clue." };
    submitMove.mockResolvedValue({
      state: soloGame({
        solo_progress: {
          claimed_cells: 0,
          total_cells: 9,
          strikes_used: 1,
          strikes_remaining: 2,
          strike_limit: 3,
          boards_won: 0,
        },
      }),
      result: "incorrect",
      feedback,
    });

    render(
      <GameBoard
        initialState={soloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    fireEvent.click(screen.getAllByText("+")[0]);
    fireEvent.click(screen.getByText("select-player"));

    await waitFor(() =>
      expect(submitMove).toHaveBeenCalledWith(7, {
        row_index: 0,
        col_index: 0,
        player_id: 99,
      })
    );
    expect(await screen.findByText("❌ Incorrect. Strike lost.")).toBeInTheDocument();
    expect(screen.getByText("2 strikes remaining.")).toBeInTheDocument();
    expect(screen.getByText(feedback.message)).toBeInTheDocument();
  });

  it("pauses on the solo answer reveal before showing the win screen", async () => {
    const revealRound = completedRound();
    submitMove.mockResolvedValue({
      state: soloGame({
        status: "finished",
        winner_player: 1,
        player1_score: 1,
        solo_progress: {
          claimed_cells: 3,
          total_cells: 9,
          strikes_used: 0,
          strikes_remaining: 3,
          strike_limit: 3,
          boards_won: 1,
        },
        round: revealRound,
      }),
      result: "solo_won",
      completedRound: revealRound,
    });

    render(
      <GameBoard
        initialState={soloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    fireEvent.click(screen.getAllByText("+")[0]);
    fireEvent.click(screen.getByText("select-player"));

    expect(await screen.findByText(/Solo win! Three in a row/)).toBeInTheDocument();
    expect(screen.queryByText(/Next board in/)).not.toBeInTheDocument();
    expect(screen.getByText("See Result")).toBeInTheDocument();
    expect(screen.getAllByText("Vasilije Micic").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("See Result"));

    expect(await screen.findByRole("heading", { name: "Solo board won!" })).toBeInTheDocument();
    expect(screen.getByText("Answer reveal")).toBeInTheDocument();
    expect(screen.getAllByText(/Vasilije Micic/).length).toBeGreaterThan(0);
  });

  it("uses Show answers to reveal the board and then show the neutral result screen", async () => {
    const revealRound = completedRound({
      status: "drawn",
      winner_player: null,
    });
    giveUpGame.mockResolvedValue({
      state: soloGame({
        status: "finished",
        winner_player: null,
        round: revealRound,
      }),
      result: "gave_up",
      completedRound: revealRound,
    });

    render(
      <GameBoard
        initialState={soloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    fireEvent.click(screen.getByText("Show answers"));

    await waitFor(() => expect(giveUpGame).toHaveBeenCalledWith(7));
    expect(await screen.findByText("👀 Answers revealed.")).toBeInTheDocument();
    expect(screen.getByText("See Result")).toBeInTheDocument();

    fireEvent.click(screen.getByText("See Result"));

    expect(await screen.findByRole("heading", { name: "Answers revealed" })).toBeInTheDocument();
    expect(screen.getByText("Answer reveal")).toBeInTheDocument();
  });

  it("renders the defensive solo draw result screen for a full no-winner board", () => {
    const fullDrawRound = completedRound({
      status: "drawn",
      winner_player: null,
      cells: boardCells().map((cell, index) => ({
        ...cell,
        claimed_by_player: index % 2 === 0 ? 1 : 2,
        claimed_player_name: index % 2 === 0 ? "Solo Pick" : "Blocker",
        sample_answers: ["Vasilije Micic"],
      })),
    });

    render(
      <GameBoard
        initialState={soloGame({
          status: "finished",
          winner_player: null,
          solo_progress: {
            claimed_cells: 5,
            total_cells: 9,
            strikes_used: 1,
            strikes_remaining: 2,
            strike_limit: 3,
            boards_won: 0,
          },
          round: fullDrawRound,
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    expect(screen.getByRole("heading", { name: "Board complete" })).toBeInTheDocument();
    expect(screen.getByText("No three-in-a-row on the finished board.")).toBeInTheDocument();
  });
});

describe("GameBoard claimed-cell colors (issue #262)", () => {
  // Builds an active board where the given cells are pre-claimed so the board
  // grid renders the claimed-cell styling we want to assert on.
  function roundWithClaims(claims) {
    return {
      columns: [axis("A"), axis("B"), axis("C")],
      rows: [axis("1"), axis("2"), axis("3")],
      cells: boardCells().map((cell) => {
        const claim = claims.find(
          (c) => c.row === cell.row_index && c.col === cell.col_index
        );
        return claim
          ? {
              ...cell,
              claimed_by_player: claim.player,
              claimed_player_name: claim.name,
            }
          : cell;
      }),
    };
  }

  it("renders solo claimed cells with a neutral green accent, not Player-1 blue", () => {
    render(
      <GameBoard
        initialState={soloGame({
          round: roundWithClaims([{ row: 0, col: 0, player: 1, name: "Solo Claim Pick" }]),
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const nameEl = screen.getByText("Solo Claim Pick");
    const button = nameEl.closest("button");
    expect(button.className).toContain("bg-emerald-100");
    expect(button.className).not.toContain("bg-elq-player1-bg");
    expect(nameEl.className).toContain("text-emerald-800");
    expect(nameEl.className).not.toContain("text-elq-player1");
  });

  it("keeps the Player-1 blue identity for local 1v1 claimed cells", () => {
    render(
      <GameBoard
        initialState={activeGame({
          mode: "local_two_player",
          round: roundWithClaims([{ row: 0, col: 0, player: 1, name: "Local Blue Pick" }]),
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const nameEl = screen.getByText("Local Blue Pick");
    const button = nameEl.closest("button");
    expect(button.className).toContain("bg-elq-player1-bg");
    expect(button.className).not.toContain("bg-emerald-100");
    expect(nameEl.className).toContain("text-elq-player1");
    expect(nameEl.className).not.toContain("text-emerald-800");
  });

  it("keeps the Player-1-blue / Player-2-red identity for online claimed cells", () => {
    render(
      <GameBoard
        initialState={activeGame({
          mode: "online_friend",
          round: roundWithClaims([
            { row: 0, col: 0, player: 1, name: "Online P1 Pick" },
            { row: 0, col: 1, player: 2, name: "Online P2 Pick" },
          ]),
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    const p1 = screen.getByText("Online P1 Pick");
    const p2 = screen.getByText("Online P2 Pick");
    expect(p1.closest("button").className).toContain("bg-elq-player1-bg");
    expect(p1.closest("button").className).not.toContain("bg-emerald-100");
    expect(p1.className).toContain("text-elq-player1");
    expect(p2.closest("button").className).toContain("bg-elq-player2-bg");
    expect(p2.className).toContain("text-elq-player2");
  });

  it("renders the solo answer-reveal pick in green, not Player-1 blue", () => {
    render(
      <GameBoard
        initialState={soloGame({
          status: "finished",
          winner_player: 1,
          round: {
            columns: [axis("A"), axis("B"), axis("C")],
            rows: [axis("1"), axis("2"), axis("3")],
            status: "completed",
            winner_player: 1,
            cells: boardCells().map((cell, i) =>
              i === 0
                ? {
                    ...cell,
                    claimed_by_player: 1,
                    claimed_player_name: "Reveal Pick",
                    sample_answers: ["Vasilije Micic"],
                  }
                : cell
            ),
          },
          solo_progress: {
            claimed_cells: 1,
            total_cells: 9,
            strikes_used: 0,
            strikes_remaining: 3,
            strike_limit: 3,
            boards_won: 0,
          },
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const pickEl = screen.getByText(/Your pick: Reveal Pick/);
    expect(pickEl.className).toContain("text-emerald-700");
    expect(pickEl.className).not.toContain("text-elq-player1");
  });
});

describe("GameBoard claimed-cell name wrapping (issue #263)", () => {
  // Mirrors the issue #262 helper: pre-claim cells so the board renders the
  // claimed-cell name we assert wrapping behaviour on.
  function roundWithClaims(claims) {
    return {
      columns: [axis("A"), axis("B"), axis("C")],
      rows: [axis("1"), axis("2"), axis("3")],
      cells: boardCells().map((cell) => {
        const claim = claims.find(
          (c) => c.row === cell.row_index && c.col === cell.col_index
        );
        return claim
          ? { ...cell, claimed_by_player: claim.player, claimed_player_name: claim.name }
          : cell;
      }),
    };
  }

  // The claimed name is the reward for a correct answer, so on a narrow mobile
  // cell it must wrap/scale to stay fully readable instead of clipping. The old
  // `truncate` (white-space: nowrap) on an unconstrained flex wrapper let the
  // name overflow the centered, overflow-hidden cell and clip on both sides. The
  // fix swaps `truncate` for the wrapping `.ttt-claimed-name` class and bounds the
  // flex wrapper to the cell width with `w-full min-w-0`.
  function expectWrappingName(nameEl, fullName) {
    expect(nameEl).toHaveTextContent(fullName);
    expect(nameEl.className).toContain("ttt-claimed-name");
    expect(nameEl.className).not.toContain("truncate");
    const wrapper = nameEl.closest(".animate-cell-claim");
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("w-full");
    expect(wrapper.className).toContain("min-w-0");
  }

  it("wraps the full claimed name in solo mode instead of clipping it", () => {
    render(
      <GameBoard
        initialState={soloGame({
          round: roundWithClaims([{ row: 0, col: 0, player: 1, name: "Nando De Colo" }]),
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    expectWrappingName(screen.getByText("Nando De Colo"), "Nando De Colo");
  });

  it("wraps the full claimed name in local 1v1 mode", () => {
    render(
      <GameBoard
        initialState={activeGame({
          mode: "local_two_player",
          round: roundWithClaims([{ row: 0, col: 0, player: 1, name: "Sergio Rodriguez" }]),
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    expectWrappingName(screen.getByText("Sergio Rodriguez"), "Sergio Rodriguez");
  });

  it("wraps the full claimed name for both players in online mode", () => {
    render(
      <GameBoard
        initialState={activeGame({
          mode: "online_friend",
          round: roundWithClaims([
            { row: 0, col: 0, player: 1, name: "Nando De Colo" },
            { row: 0, col: 1, player: 2, name: "Sergio Rodriguez" },
          ]),
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    expectWrappingName(screen.getByText("Nando De Colo"), "Nando De Colo");
    expectWrappingName(screen.getByText("Sergio Rodriguez"), "Sergio Rodriguez");
  });
});

describe("GameBoard end-of-game result", () => {
  it("reveals the inline result and clears the waiting indicator when the opponent resigns", async () => {
    // Player 2 is the viewer and it is player 1's turn, so the stale-prone
    // "Waiting for opponent..." indicator is on screen before the match ends.
    render(
      <GameBoard
        initialState={activeGame({ current_player: 1 })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    expect(screen.getByText("Waiting for opponent...")).toBeInTheDocument();

    // Player 1 resigns remotely; player 2 wins. The result must surface on the
    // inline result screen and the waiting indicator must vanish once the game
    // is no longer active.
    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: 2, current_player: 1 }),
        result: "resigned",
      });
    });

    expect(await screen.findByText("Your opponent resigned.")).toBeInTheDocument();
    expect(screen.getByText(/WINS!/)).toBeInTheDocument();
    expect(screen.queryByText("Waiting for opponent...")).not.toBeInTheDocument();
  });

  it("shows the result only after the round transition for a normal final-round win", () => {
    vi.useFakeTimers();
    try {
      render(
        <GameBoard
          initialState={activeGame()}
          onNewGame={() => {}}
          onHome={() => {}}
          onlineInfo={{ isOnline: true, playerNumber: 1 }}
        />
      );

      // A match-winning move flows through the shared 3s round transition, during
      // which the result screen stays hidden (no flicker of the final reveal).
      act(() => {
        realtimeHolder.opts.onState({
          state: activeGame({ status: "finished", winner_player: 1 }),
          result: "match_won",
          completedRound: {
            columns: [axis("A"), axis("B"), axis("C")],
            rows: [axis("1"), axis("2"), axis("3")],
            cells: [],
          },
        });
      });

      expect(screen.queryByText(/WINS!/)).not.toBeInTheDocument();

      // The countdown reschedules a fresh 1s timeout after each React flush, so
      // advance it one second at a time until the transition clears.
      for (let i = 0; i < 4; i++) {
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }

      // After the transition the result appears with the generic, perspective-aware
      // win line (no forfeit reason for a normal win).
      expect(screen.getByText(/WINS!/)).toBeInTheDocument();
      expect(screen.getByText("You won the match!")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a persistent inline result with no dismiss control", async () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: 2 }),
        result: "resigned",
      });
    });

    // The unified result screen replaces the board inline — it is not a
    // dismissible modal, so the forfeit reason and winner stay on screen.
    expect(await screen.findByText("Your opponent resigned.")).toBeInTheDocument();
    expect(screen.getByText(/WINS!/)).toBeInTheDocument();

    // The old dismissible modal is gone: no Close button, no "View result" pill,
    // and no dialog role to dismiss.
    expect(screen.queryByLabelText("Close")).toBeNull();
    expect(screen.queryByText("View result")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    // The end-of-game actions use the standardized, cross-game labels.
    expect(screen.getByText("Play Again")).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
  });

  it("renders a finished solo loss result screen after refresh", () => {
    render(
      <GameBoard
        initialState={soloGame({
          status: "finished",
          winner_player: null,
          solo_progress: {
            claimed_cells: 2,
            total_cells: 9,
            strikes_used: 3,
            strikes_remaining: 0,
            strike_limit: 3,
            boards_won: 0,
          },
          round: completedRound({
            status: "drawn",
            winner_player: null,
          }),
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    expect(screen.getByRole("heading", { name: "Out of strikes" })).toBeInTheDocument();
    expect(screen.getByText("Play Again")).toBeInTheDocument();
    expect(screen.getByText("Answer reveal")).toBeInTheDocument();
  });

  it("does not credit Player 2 when a finished online game has no winner", async () => {
    render(
      <GameBoard
        initialState={activeGame({ current_player: 1 })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 2 }}
      />
    );

    // A null winner must not fall through to the Player 2 name; the shared
    // winnerDisplayName helper renders a neutral "No winner" headline.
    act(() => {
      realtimeHolder.opts.onState({
        state: activeGame({ status: "finished", winner_player: null }),
      });
    });

    expect(await screen.findByRole("heading", { name: "No winner" })).toBeInTheDocument();
    expect(screen.queryByText("Bob WINS!")).not.toBeInTheDocument();
  });
});

describe("GameBoard header navigation", () => {
  it("exposes a single consistent Home control that returns to the app home", () => {
    const onHome = vi.fn();
    const onNewGame = vi.fn();

    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={onNewGame}
        onHome={onHome}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));

    expect(onHome).toHaveBeenCalledTimes(1);
    expect(onNewGame).not.toHaveBeenCalled();
    // The previous centered logo nav is gone, leaving a single home affordance.
    expect(screen.queryByRole("button", { name: "EuroLeague Quiz" })).toBeNull();
  });

  it("renders the unified online scoreboard with a seat-colored self-indicator", () => {
    render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={vi.fn()}
        onHome={vi.fn()}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );

    const scoreboard = screen.getByLabelText("TicTacToe multiplayer scoreboard");
    expect(within(scoreboard).getByText("Alice")).toBeInTheDocument();
    expect(within(scoreboard).getByText("Bob")).toBeInTheDocument();
    expect(within(scoreboard).getByText("Round 1")).toBeInTheDocument();
    expect(within(scoreboard).getByText("First to 3")).toBeInTheDocument();

    const pill = within(scoreboard).getByText("You are Alice").closest("div");
    expect(pill.querySelector(".bg-elq-player1")).toBeTruthy();
  });
});

describe("GameBoard solo / local never shows the online Resign control (issue #150)", () => {
  // A stale `elq_game_<id>` seat (from an earlier online game whose numeric id was
  // later reused by a brand-new solo/local game) can hand the board a truthy
  // `onlineInfo`. The board must still refuse to go online based on the game mode.
  const staleSeat = { isOnline: true, playerNumber: 1 };

  it("renders only Show answers (no Resign) for a single_player game with a stale seat", () => {
    render(
      <GameBoard
        initialState={activeGame({ mode: "single_player" })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={staleSeat}
      />
    );

    expect(screen.getByText("Show answers")).toBeInTheDocument();
    expect(screen.queryByText("Resign")).not.toBeInTheDocument();
    // The leak is behavioural too: the realtime transport must stay disabled.
    expect(realtimeHolder.opts.enabled).toBe(false);
  });

  it("renders no Resign for a local_two_player game with a stale seat", () => {
    render(
      <GameBoard
        initialState={activeGame({ mode: "local_two_player" })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={staleSeat}
      />
    );

    expect(screen.queryByText("Resign")).not.toBeInTheDocument();
    expect(realtimeHolder.opts.enabled).toBe(false);
  });
});

describe("GameBoard height-aware board sizing (issue #259)", () => {
  // The board must fit a laptop viewport without scrolling. We assert the
  // height-aware sizing wiring is present (not pixel sizes, which jsdom does
  // not compute): the grid tracks consume the cell variable, and the sizing
  // container declares a viewport-height-derived cell with a mode-aware
  // reserve. The actual fit is verified in a real browser.
  const sizingContainer = (container) =>
    [...container.querySelectorAll("div[style]")].find((d) =>
      d.style.getPropertyValue("--ttt-reserve")
    );

  const boardRows = (container) =>
    [...container.querySelectorAll("div[style]")].filter((d) =>
      (d.style.gridTemplateColumns || "").includes("var(--ttt-cell)")
    );

  it("drives the board grid from a viewport-height-aware cell variable", () => {
    const { container } = render(
      <GameBoard
        initialState={soloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const sizing = sizingContainer(container);
    expect(sizing).toBeTruthy();
    // Cell height is bounded by the viewport height so short laptops shrink it.
    expect(sizing.style.getPropertyValue("--ttt-cell")).toContain("svh");
    expect(sizing.style.getPropertyValue("--ttt-reserve")).toMatch(/px$/);

    // Every header/cell row references the shared cell track, not 1fr columns.
    const rows = boardRows(container);
    expect(rows.length).toBe(4); // 1 header row + 3 cell rows
  });

  it("reserves more non-cell height for online than solo chrome", () => {
    const solo = render(
      <GameBoard
        initialState={soloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );
    const soloReserve = parseInt(
      sizingContainer(solo.container).style.getPropertyValue("--ttt-reserve"),
      10
    );
    solo.unmount();

    const online = render(
      <GameBoard
        initialState={activeGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: true, playerNumber: 1 }}
      />
    );
    const onlineReserve = parseInt(
      sizingContainer(online.container).style.getPropertyValue("--ttt-reserve"),
      10
    );

    expect(onlineReserve).toBeGreaterThan(soloReserve);
  });
});

describe("GameBoard desktop Solo command rail (issue #266)", () => {
  // jsdom has no matchMedia, so the component defaults to the stacked/mobile
  // layout everywhere else. Installing a matches=true stub flips useMediaQuery's
  // (min-width: 1024px) check on so the desktop two-pane Solo layout renders.
  let originalMatchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query) => ({
      matches: query.includes("min-width: 1024px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    if (originalMatchMedia === undefined) {
      delete window.matchMedia;
    } else {
      window.matchMedia = originalMatchMedia;
    }
  });

  const sizingContainer = (container) =>
    [...container.querySelectorAll("div[style]")].find((d) =>
      d.style.getPropertyValue("--ttt-reserve")
    );

  const boardRows = (container) =>
    [...container.querySelectorAll("div[style]")].filter((d) =>
      (d.style.gridTemplateColumns || "").includes("var(--ttt-cell)")
    );

  it("renders the left command rail without duplicating the board or progress", () => {
    const { container } = render(
      <GameBoard
        initialState={soloGame({
          solo_progress: {
            claimed_cells: 4,
            total_cells: 9,
            strikes_used: 1,
            strikes_remaining: 2,
            strike_limit: 3,
            boards_won: 1,
          },
        })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    // The two-pane rail wrapper is present and the progress/board/controls each
    // render exactly once (no CSS-hidden duplicate layout).
    const rail = screen.getByLabelText("TicTacToe solo command rail");
    expect(rail).toBeInTheDocument();
    expect(screen.getAllByLabelText("TicTacToe solo progress")).toHaveLength(1);
    expect(within(rail).getByLabelText("TicTacToe solo progress")).toBeInTheDocument();
    expect(screen.getAllByText("Show answers")).toHaveLength(1);
    expect(within(rail).getByText("Show answers")).toBeInTheDocument();

    // Rail teaches via "How to play"; the always-on clue legend and the full
    // guide's first-run card / objective line are intentionally dropped here.
    expect(screen.getAllByTestId("ttt-howto-trigger")).toHaveLength(1);
    expect(within(rail).getByTestId("ttt-howto-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("ttt-legend-trigger")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ttt-objective")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ttt-howto")).not.toBeInTheDocument();

    // A single board (1 header row + 3 cell rows) renders in the board pane.
    expect(boardRows(container)).toHaveLength(4);

    // The "Solo" header indicator replaces the empty placeholder.
    expect(screen.getByText("Solo")).toBeInTheDocument();
  });

  it("shrinks the board reserve below the stacked solo value so the board uses the freed height", () => {
    const { container } = render(
      <GameBoard
        initialState={soloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const reserve = sizingContainer(container).style.getPropertyValue("--ttt-reserve");
    expect(reserve).toMatch(/px$/);
    // Less chrome above the board than the 404px stacked solo reserve.
    expect(parseInt(reserve, 10)).toBeLessThan(404);
    // Cell var still height-aware so short laptops shrink the board to fit.
    expect(sizingContainer(container).style.getPropertyValue("--ttt-cell")).toContain("svh");
  });

  it("reveals answers from the rail and then shows the neutral result screen", async () => {
    const revealRound = completedRound({
      status: "drawn",
      winner_player: null,
    });
    giveUpGame.mockResolvedValue({
      state: soloGame({
        status: "finished",
        winner_player: null,
        round: revealRound,
      }),
      result: "gave_up",
      completedRound: revealRound,
    });

    render(
      <GameBoard
        initialState={soloGame()}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    const rail = screen.getByLabelText("TicTacToe solo command rail");
    fireEvent.click(within(rail).getByText("Show answers"));

    await waitFor(() => expect(giveUpGame).toHaveBeenCalledWith(7));
    // The reveal feedback banner surfaces inside the rail, not the board pane.
    expect(await screen.findByText("👀 Answers revealed.")).toBeInTheDocument();

    fireEvent.click(screen.getByText("See Result"));

    expect(
      await screen.findByRole("heading", { name: "Answers revealed" })
    ).toBeInTheDocument();
    expect(screen.getByText("Answer reveal")).toBeInTheDocument();
  });

  it("keeps Local 1v1 on the stacked layout even at desktop width", () => {
    render(
      <GameBoard
        initialState={activeGame({ mode: "local_multiplayer", player2_name: "Bob" })}
        onNewGame={() => {}}
        onHome={() => {}}
        onlineInfo={{ isOnline: false }}
      />
    );

    // Non-solo never uses the Solo rail, even on a wide screen.
    expect(screen.queryByLabelText("TicTacToe solo command rail")).not.toBeInTheDocument();
    expect(screen.getByLabelText("TicTacToe multiplayer scoreboard")).toBeInTheDocument();
  });
});

