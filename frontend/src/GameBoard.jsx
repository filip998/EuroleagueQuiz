import { useState, useEffect } from "react";
import { getGame, submitMove, offerDraw, respondDraw, giveUpGame, cancelQuickMatchTicTacToe, connectTicTacToeRealtime } from "./api";
import { REALTIME_CLIENT_ACTIONS } from "./realtimeSchema";
import { optimizeHeadshot, handleHeadshotError, HEADSHOT_WIDTHS } from "./imageUrl";
import { useOnlineGameRealtime } from "./useOnlineGameRealtime";
import PlayerSearch from "./PlayerSearch";
import BoardHeaderNav from "./BoardHeaderNav";
import GameResult from "./GameResult";
import { winnerDisplayName } from "./winnerName";
import OnlineScoreboard from "./OnlineScoreboard";
import ClubLogo from "./ClubLogo";
import WaitingLobby from "./WaitingLobby";
import ResignControl from "./ResignControl";
import QuickMatchSearchingLobby from "./QuickMatchSearchingLobby";
import TicTacToeGuide from "./TicTacToeGuide";
import { buildInviteUrl } from "./inviteLink";
import { clearOnlineInfo } from "./onlineRecovery";
import { forgetQuickMatchSeat } from "./quickMatchSeats";

// Per-axis-type chip palette. Colours are the only thing that distinguishes the
// non-image axis types (position pill, champion badge, stat-milestone chip), so
// each type that has no logo/photo gets its own background.
const AXIS_CHIP_STYLES = {
  nationality: "bg-emerald-50 text-emerald-800 border-emerald-200",
  played_with: "bg-amber-50 text-amber-800 border-amber-200",
  season: "bg-violet-50 text-violet-800 border-violet-200",
  position: "bg-sky-50 text-sky-800 border-sky-200",
  champion: "bg-yellow-50 text-yellow-800 border-yellow-300",
  stat_milestone: "bg-rose-50 text-rose-800 border-rose-200",
};

const SOLO_STRIKE_LIMIT = 3;
const SOLO_TOTAL_CELLS = 9;
const SOLO_TERMINAL_RESULTS = new Set(["solo_won", "solo_lost", "solo_drawn", "gave_up"]);
const ROUND_REVEAL_RESULTS = new Set([
  "round_won",
  "round_drawn",
  "match_won",
  "board_complete",
  "solo_won",
  "solo_lost",
  "solo_drawn",
  "draw_accepted",
]);

function buildSoloProgress(game, round) {
  const progress = game?.solo_progress || {};
  const strikeLimit = progress.strike_limit ?? SOLO_STRIKE_LIMIT;
  const strikesUsed = Math.min(
    Math.max(progress.strikes_used ?? game?.player2_score ?? 0, 0),
    strikeLimit
  );
  const totalCells = progress.total_cells ?? round?.cells?.length ?? SOLO_TOTAL_CELLS;
  const claimedCells =
    progress.claimed_cells ??
    round?.cells?.filter((cell) => cell.claimed_by_player === 1).length ??
    0;
  return {
    claimedCells,
    totalCells,
    strikesUsed,
    strikesRemaining: progress.strikes_remaining ?? Math.max(0, strikeLimit - strikesUsed),
    strikeLimit,
    boardsWon: progress.boards_won ?? Math.max(game?.player1_score ?? 0, 0),
  };
}

function clueText(axis) {
  return axis?.display_label || axis?.team_name || "Clue";
}

function SoloAnswerReveal({ round }) {
  const cellsWithAnswers =
    round?.cells?.filter((cell) => cell.sample_answers?.length || cell.claimed_player_name) || [];
  if (!cellsWithAnswers.length) return null;

  return (
    <div className="mb-6 text-left">
      <h3 className="text-sm font-bold uppercase tracking-wide text-elq-muted mb-2">
        Answer reveal
      </h3>
      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {cellsWithAnswers.map((cell) => (
          <div
            key={`${cell.row_index}-${cell.col_index}`}
            className="rounded-xl border border-elq-border bg-elq-bg/70 p-3"
          >
            <div className="text-sm font-semibold text-elq-dark">
              {clueText(cell.row_axis)} × {clueText(cell.col_axis)}
            </div>
            {cell.claimed_player_name && (
              <div className="text-sm text-elq-player1 mt-1">
                Your pick: {cell.claimed_player_name}
              </div>
            )}
            {cell.sample_answers?.length > 0 && (
              <div className="text-sm text-elq-muted mt-1">
                {cell.claimed_player_name ? "Also works: " : "Examples: "}
                {cell.sample_answers.join(", ")}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SoloEndStats({ progress }) {
  return (
    <div className="grid grid-cols-2 gap-2 mb-5 text-sm">
      <div className="rounded-xl bg-elq-bg border border-elq-border p-3">
        <div className="text-elq-muted">Cells claimed</div>
        <div className="font-bold text-elq-dark">
          {progress.claimedCells}/{progress.totalCells}
        </div>
      </div>
      <div className="rounded-xl bg-elq-bg border border-elq-border p-3">
        <div className="text-elq-muted">Strikes</div>
        <div className="font-bold text-elq-dark">
          {progress.strikesUsed}/{progress.strikeLimit}
        </div>
      </div>
    </div>
  );
}

function isRoundFull(round) {
  return Boolean(
    round?.cells?.length &&
      round.cells.every((cell) => cell.claimed_by_player != null)
  );
}

function soloResultPresentation(game, progress, lastResult, round) {
  const result =
    lastResult ||
    (game.winner_player === 1
      ? "solo_won"
      : progress.strikesRemaining === 0
        ? "solo_lost"
        : round?.status === "drawn" && isRoundFull(round)
          ? "solo_drawn"
          : "gave_up");

  if (result === "solo_won") {
    return {
      emoji: "🏆",
      title: "Solo board won!",
      subtitle: `Three in a row with ${progress.strikesRemaining} strike${progress.strikesRemaining === 1 ? "" : "s"} left.`,
      celebrate: true,
    };
  }
  if (result === "solo_lost") {
    return {
      emoji: "❌",
      title: "Out of strikes",
      subtitle: `You used all ${progress.strikeLimit} strikes before completing a line.`,
      celebrate: false,
    };
  }
  if (result === "solo_drawn") {
    return {
      emoji: "🤝",
      title: "Board complete",
      subtitle: "No three-in-a-row on the finished board.",
      celebrate: false,
    };
  }
  return {
    emoji: "👀",
    title: "Answers revealed",
    subtitle: "Study the board, then try again when you are ready.",
    celebrate: false,
  };
}

export function AxisLabel({ axis }) {
  const axisType = axis?.axis_type;
  const isTeam = axisType === "team";
  const isPlayedWith = axisType === "played_with";
  const isSeason = axisType === "season";
  const isNationality = axisType === "nationality";
  const isChampion = axisType === "champion";
  const isStatMilestone = axisType === "stat_milestone";
  const countryCode = isNationality ? axis.country_code : null;
  const imageUrl = isPlayedWith ? axis.image_url : null;
  // Milestone labels (e.g. "15+ PPG season", "1,000+ career points") come from
  // the backend display_label so calibration changes need no frontend edit.
  const label = axis?.display_label || axis?.team_name || "\u2014";
  const prefix =
    isNationality && !countryCode
      ? "\ud83c\udf0d "
      : isSeason
        ? "\ud83d\udcc5 "
        : isChampion
          ? "\ud83c\udfc6 "
          : isStatMilestone
            ? "\ud83d\udcca "
            : "";
  const bgColor =
    AXIS_CHIP_STYLES[axisType] || "bg-slate-50 text-slate-700 border-slate-200";
  return (
    <div
      className={`px-2 py-1.5 text-[11px] sm:text-xs font-semibold text-center rounded-lg border ${bgColor} leading-tight flex flex-col items-center justify-center gap-0.5 min-w-0`}
    >
      {isTeam && axis.team_code && (
        <ClubLogo code={axis.team_code} size={28} alt={axis.team_name || label} />
      )}
      {isPlayedWith && (
        <span className="text-[9px] font-bold uppercase tracking-wide opacity-80 leading-none">
          {"\ud83e\udd1d"} Played with
        </span>
      )}
      {imageUrl && (
        <img
          src={optimizeHeadshot(imageUrl, { width: HEADSHOT_WIDTHS.avatar })}
          alt={label}
          className="w-5 h-5 rounded-full object-cover object-top border border-amber-300"
          onError={(e) => handleHeadshotError(e, imageUrl, (ev) => { ev.currentTarget.style.display = "none"; })}
        />
      )}
      {countryCode && (
        <img
          src={`https://flagcdn.com/w80/${countryCode.toLowerCase()}.png`}
          alt={label}
          className="w-8 h-6 object-cover rounded-sm border border-emerald-200"
          onError={(e) => { e.target.style.display = "none"; }}
        />
      )}
      <span className="max-w-full break-words">
        {prefix}
        {label}
      </span>
    </div>
  );
}

export default function GameBoard({ initialState, onNewGame, onHome, onlineInfo }) {
  const [game, setGame] = useState(initialState?.game || initialState);
  const [selectedCell, setSelectedCell] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [lastFeedback, setLastFeedback] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const [roundTransition, setRoundTransition] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  const isSolo = game?.mode === "single_player";
  // A solo / local game must never be treated as online, even if `onlineInfo`
  // carries a stale seat recovered for a reused game id (see onlineRecovery.js).
  const isOnline = game?.mode === "online_friend" && Boolean(onlineInfo?.isOnline);
  const myPlayer = onlineInfo?.playerNumber;
  const realtimeUnavailableMessage = "Realtime connection unavailable. Reconnecting...";

  function handleRealtimeState(message) {
    const result = message.result;
    const feedback = message.feedback || null;
    setGame(message.state);
    setError(null);
    if (result && message.completedRound && ROUND_REVEAL_RESULTS.has(result)) {
      startRoundTransition(result, message.completedRound, feedback);
    } else if (result) {
      setLastResult(result);
      setLastFeedback(feedback);
      setSelectedCell(null);
    } else {
      setLastFeedback(null);
    }
  }

  const realtime = useOnlineGameRealtime({
    enabled: isOnline,
    gameId: game?.id,
    gameStatus: game?.status,
    playerNumber: myPlayer,
    connect: connectTicTacToeRealtime,
    fetchState: getGame,
    onState: handleRealtimeState,
    onError: setError,
  });

  const round = game?.round;
  const soloProgress = isSolo ? buildSoloProgress(game, round) : null;

  // Sync timer
  useEffect(() => {
    if (!game?.turn_seconds || game.status !== "active") {
      setTimeLeft(null);
      return;
    }

    if (isOnline && game.turn_deadline_utc) {
      const computeRemaining = () => {
        const deadline = new Date(game.turn_deadline_utc).getTime();
        return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      };

      setTimeLeft(computeRemaining());

      const timer = setInterval(() => {
        const remaining = computeRemaining();
        setTimeLeft(remaining);
        if (remaining <= 0) {
          setSelectedCell(null);
        }
      }, 1000);

      return () => clearInterval(timer);
    } else {
      setTimeLeft(game.turn_seconds);
    }
  }, [game?.turn_deadline_utc, game?.current_player, game?.round_number, game?.turn_seconds, game?.status, isOnline]);

  // Local-only countdown tick
  useEffect(() => {
    if (isOnline) return;
    if (!game?.turn_seconds || game.status !== "active" || timeLeft === null) return;
    if (timeLeft <= 0) {
      if (!isSolo) {
        setGame((prev) => ({
          ...prev,
          current_player: prev.current_player === 1 ? 2 : 1,
        }));
      }
      setLastResult("time_expired");
      setLastFeedback(null);
      setSelectedCell(null);
      return;
    }
    const timer = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft, game?.turn_seconds, game?.status, isOnline, isSolo]);

  // Round transition countdown
  useEffect(() => {
    if (!roundTransition) return;
    if (roundTransition.countdown === null) return; // paused (solo give-up)
    if (roundTransition.countdown <= 0) {
      setRoundTransition(null);
      return;
    }
    const timer = setTimeout(() => {
      setRoundTransition((prev) =>
        prev ? { ...prev, countdown: prev.countdown - 1 } : null
      );
    }, 1000);
    return () => clearTimeout(timer);
  }, [roundTransition]);

  function startRoundTransition(result, completedRound, feedback = null) {
    if (completedRound) {
      setRoundTransition({
        countdown: SOLO_TERMINAL_RESULTS.has(result) ? null : 3,
        completedRound,
        result,
      });
    }
    setLastResult(result);
    setLastFeedback(feedback);
    setSelectedCell(null);
  }

  function handleCellClick(cell) {
    if (game.status !== "active") return;
    if (cell.claimed_by_player) return;
    if (game.pending_draw) return;
    if (isOnline && game.current_player !== myPlayer) return;
    setSelectedCell(cell);
    setError(null);
    setLastResult(null);
    setLastFeedback(null);
  }

  async function handlePlayerSelect(player) {
    if (!selectedCell) return;
    setLoading(true);
    setError(null);
    try {
      if (isOnline) {
        if (realtime.sendAction(REALTIME_CLIENT_ACTIONS.MOVE, {
          row_index: selectedCell.row_index,
          col_index: selectedCell.col_index,
          player_id: player.player_id,
        })) {
          setSelectedCell(null);
        } else {
          setError(realtimeUnavailableMessage);
        }
        return;
      }

      const res = await submitMove(game.id, {
        row_index: selectedCell.row_index,
        col_index: selectedCell.col_index,
        player_id: player.player_id,
      });
      handleRealtimeState(res);
      setSelectedCell(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOfferDraw() {
    setLoading(true);
    setError(null);
    try {
      if (isOnline) {
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.OFFER_DRAW)) {
          setError(realtimeUnavailableMessage);
        }
        return;
      }

      const res = await offerDraw(game.id);
      handleRealtimeState(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRespondDraw(accept) {
    setLoading(true);
    setError(null);
    try {
      if (isOnline) {
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.RESPOND_DRAW, { accept })) {
          setError(realtimeUnavailableMessage);
        }
        return;
      }

      const res = await respondDraw(game.id, accept);
      handleRealtimeState(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleGiveUp() {
    setLoading(true);
    setError(null);
    try {
      const res = await giveUpGame(game.id);
      setGame(res.state);
      if (res.completedRound) {
        const result = res.result || "gave_up";
        setRoundTransition({ countdown: null, completedRound: res.completedRound, result });
        setLastResult(result);
        setLastFeedback(res.feedback || null);
        setSelectedCell(null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Online resign forfeits the whole match. Use the HTTP give-up endpoint as the
  // primary path (reliable request/response that also broadcasts the terminal
  // state to the opponent) rather than fire-and-forget over the WebSocket.
  async function handleResign() {
    setLoading(true);
    setError(null);
    try {
      const res = await giveUpGame(game.id, myPlayer);
      handleRealtimeState(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleQuickCancel() {
    if (cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await cancelQuickMatchTicTacToe({ preset: game.preset, game_id: game.id });
      // The backend deletes the waiting row, freeing its id for SQLite to reuse.
      // Drop this game's recovery data so a later game with the same id can't
      // recover the stale online seat and connect as the wrong player.
      clearOnlineInfo(game.id);
      forgetQuickMatchSeat(game.id);
      onNewGame();
    } catch {
      // The search was likely matched a moment before cancelling (the backend
      // rejects cancelling a game that is no longer waiting). Stay on the board;
      // the realtime hook will flip to the active game. No scary error.
      setCancelling(false);
    }
  }

  // Waiting for opponent screen
  if (game?.status === "waiting_for_opponent") {
    if (game.is_public && game.preset) {
      return (
        <QuickMatchSearchingLobby
          preset={game.preset}
          onCancel={handleQuickCancel}
          cancelling={cancelling}
        />
      );
    }
    return (
      <WaitingLobby
        joinCode={game.join_code}
        inviteUrl={buildInviteUrl(game.join_code)}
        onCancel={onNewGame}
      />
    );
  }

  if (!game || !round) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <svg className="w-8 h-8 text-elq-orange animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
        </svg>
      </div>
    );
  }

  const displayRound = roundTransition?.completedRound || round;
  const inTransition = !!roundTransition;

  const currentPlayerName =
    game.current_player === 1 ? game.player1_name : game.player2_name;
  const isMyTurn = !isOnline || game.current_player === myPlayer;

  // Height-aware board sizing (issue #259): the full 3x3 grid + axis headers must
  // fit a laptop viewport without scrolling. Each cell is the MIN of a
  // width-derived track and a height-derived track:
  //   width  = (100cqw - axis - gaps) / 3   -> a hard upper bound, so the board
  //            can never be wider than its container (no mobile h-overflow at any
  //            width), and
  //   height = clamp(72px, (100svh - reserve) / 3, 176px) -> shrinks the board on
  //            short viewports, floored so cells stay tappable and capped so
  //            large desktops keep the original ~176px cells.
  // `--ttt-reserve` is every non-cell vertical pixel (page/header chrome +
  // scoreboard + guide + the transient result/feedback banner + the column-header
  // row + grid gaps + the control(s) beneath the board). It is mode-aware because
  // the shared multiplayer scoreboard (local/online) is much taller than the solo
  // card and online additionally stacks the "Online" status bar plus the combined
  // Offer Draw / Resign control row under the board. The reserve deliberately
  // budgets the (transient) single-line feedback banner ("Time's up", "Incorrect",
  // ...) so the third row stays above the fold even while that banner is showing;
  // because the row-axis labels (e.g. "PLAYED WITH" chips) sit in the fixed
  // `--ttt-axis` track, shrinking the cell shrinks the whole row down to the 72px
  // floor. Online is pinned to that floor for maximum banner headroom. Calibrated
  // against real 1366x768 / 1280x900 measurements (incl. tall played_with boards
  // with the banner visible); natural page scroll remains the ultimate fallback so
  // nothing is ever clipped.
  const boardReserve = isSolo ? "404px" : isOnline ? "552px" : "524px";
  const boardSizingStyle = {
    animationDelay: "100ms",
    containerType: "inline-size",
    "--ttt-reserve": boardReserve,
    "--ttt-axis": "clamp(72px, 14cqw, 92px)",
    "--ttt-cell":
      "min(calc((100cqw - var(--ttt-axis) - 18px) / 3), clamp(72px, calc((100svh - var(--ttt-reserve)) / 3), 176px))",
  };
  const boardGridStyle = {
    gridTemplateColumns: "var(--ttt-axis) repeat(3, var(--ttt-cell))",
  };

  const resultMessages = {
    correct: isSolo ? "\u2705 Correct!" : "\u2705 Correct! Turn switches.",
    incorrect: isSolo ? "\u274c Incorrect. Strike lost." : "\u274c Incorrect. Turn switches.",
    round_won: "\ud83c\udfc6 Round won!",
    round_drawn: "\ud83e\udd1d Round drawn \u2014 new board!",
    match_won: "\ud83c\udf89 Match won!",
    board_complete: "\u2705 Board complete!",
    solo_won: "\ud83c\udf89 Solo win! Three in a row.",
    solo_lost: "\u274c Out of strikes.",
    solo_drawn: "\ud83e\udd1d Board complete \u2014 no line.",
    gave_up: "\ud83d\udc40 Answers revealed.",
    draw_offered: "\ud83e\udd1d Draw offered.",
    draw_accepted: "\ud83e\udd1d Draw accepted \u2014 new board!",
    draw_declined: "Draw declined \u2014 game continues.",
    time_expired: isSolo ? "\u23f0 Time\u2019s up!" : "\u23f0 Time\u2019s up! Turn switches.",
  };

  // Perspective-aware subtitle for terminal forfeit outcomes. The plain
  // GET /games response carries no terminal reason, so this only renders when we
  // observed the realtime result (resign/disconnect); otherwise we fall back to
  // the generic "<winner> WINS!" headline.
  const iWon = isOnline && myPlayer != null && game.winner_player === myPlayer;
  let finishedReason = null;
  if (lastResult === "resigned") {
    finishedReason = iWon ? "Your opponent resigned." : "You resigned.";
  } else if (lastResult === "opponent_left") {
    finishedReason = iWon ? "Your opponent left the game." : "You left the game.";
  }

  // Subtitle shown on the finished-game result screen. Reuse the
  // perspective-aware forfeit reason when we have it; otherwise (a normal
  // final-round win, or a plain GET refresh with no terminal reason) fall back
  // to a generic line that is still perspective-aware for online players.
  const finishedSubtitle =
    finishedReason ||
    (iWon
      ? "You won the match!"
      : isOnline && myPlayer != null
        ? "Better luck next time."
        : "Match complete \u2014 well played!");

  if (isSolo && game.status === "finished" && !inTransition) {
    const presentation = soloResultPresentation(game, soloProgress, lastResult, round);
    return (
      <GameResult
        emoji={presentation.emoji}
        title={presentation.title}
        subtitle={presentation.subtitle}
        onPlayAgain={onNewGame}
        onHome={onHome}
        celebrate={presentation.celebrate}
      >
        <SoloEndStats progress={soloProgress} />
        <SoloAnswerReveal round={round} />
      </GameResult>
    );
  }

  if (!isSolo && game.status === "finished" && !inTransition) {
    const finishedWinnerName = winnerDisplayName(game);
    return (
      <GameResult
        title={finishedWinnerName ? `${finishedWinnerName} WINS!` : "No winner"}
        subtitle={finishedSubtitle}
        onPlayAgain={onNewGame}
        onHome={onHome}
        celebrate={iWon}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Orange accent bar */}
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      {/* Header bar */}
      <div className="bg-white border-b border-elq-border">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <BoardHeaderNav onHome={onHome} />
          <span />
        </div>
      </div>

      {/* Online indicator */}
      {isOnline && (
        <div className="bg-elq-bg text-center py-1 text-xs text-elq-muted border-b border-elq-border">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Online
            {game.status === "active" && !isMyTurn && <span className="text-elq-orange ml-1">Waiting for opponent...</span>}
          </span>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center px-4 py-3 sm:py-4 max-w-2xl mx-auto w-full">
        {/* Scoreboard */}
        {isSolo ? (
          <div
            className="w-full bg-white rounded-2xl border border-elq-border shadow-sm p-3 sm:p-4 mb-3 animate-fade-in-up"
            aria-label="TicTacToe solo progress"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-elq-muted">
                  Objective
                </div>
                <div className="text-base sm:text-lg font-bold text-elq-dark">
                  Make three in a row
                </div>
                {soloProgress.boardsWon > 0 && (
                  <div className="mt-0.5 text-xs font-semibold text-elq-muted">
                    Boards won: {soloProgress.boardsWon}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-5 sm:gap-7">
                <div className="text-center">
                  <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-elq-muted">
                    Claimed
                  </div>
                  <div className="font-display text-2xl sm:text-3xl font-bold leading-none text-elq-dark">
                    {soloProgress.claimedCells}/{soloProgress.totalCells}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-elq-muted">
                    Strikes left
                  </div>
                  <div
                    className="mt-1 flex items-center justify-center gap-1.5"
                    role="img"
                    aria-label={`${soloProgress.strikesUsed} of ${soloProgress.strikeLimit} strikes used, ${soloProgress.strikesRemaining} remaining`}
                  >
                    {Array.from({ length: soloProgress.strikeLimit }).map((_, i) => (
                      <span
                        key={i}
                        aria-hidden="true"
                        className={`h-3 w-3 rounded-full border-2 ${
                          i < soloProgress.strikesUsed
                            ? "border-red-600 bg-red-600"
                            : "border-elq-border bg-transparent"
                        }`}
                      />
                    ))}
                    <span
                      aria-hidden="true"
                      className={`ml-1 font-display text-xl font-bold leading-none ${
                        soloProgress.strikesRemaining <= 1 ? "text-red-700" : "text-elq-dark"
                      }`}
                    >
                      {soloProgress.strikesRemaining}/{soloProgress.strikeLimit}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
        <div className="w-full">
          <OnlineScoreboard
            ariaLabel="TicTacToe multiplayer scoreboard"
            showSeatBars={false}
            players={[
              {
                name: game.player1_name,
                score: game.player1_score,
                active: game.current_player === 1 && game.status === "active",
              },
              {
                name: game.player2_name,
                score: game.player2_score,
                active: game.current_player === 2 && game.status === "active",
              },
            ]}
            youPlayerNumber={isOnline ? myPlayer : null}
            roundNumber={game.round_number}
            targetWins={game.target_wins}
            timer={
              game.turn_seconds && game.status === "active" && timeLeft !== null
                ? { seconds: timeLeft, critical: timeLeft <= 5 }
                : null
            }
            statusText={
              game.status === "finished"
                ? `\ud83c\udf89 ${game.winner_player === 1 ? game.player1_name : game.player2_name} wins!`
                : `${currentPlayerName}'s turn`
            }
          />
        </div>
        )}

        {/* Result banner */}
        {lastResult && !["resigned", "opponent_left"].includes(lastResult) && (
          <div className="w-full mb-2 animate-slide-down">
            <div
              className={`p-2 rounded-xl text-center text-sm font-medium ${
                ["round_won", "match_won", "board_complete", "solo_won"].includes(lastResult)
                  ? "bg-elq-orange/10 text-elq-orange border border-elq-orange/20"
                  : lastResult === "correct"
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                    : ["incorrect", "time_expired", "solo_lost"].includes(lastResult)
                      ? "bg-red-50 text-red-700 border border-red-200"
                      : "bg-amber-50 text-amber-700 border border-amber-200"
              }`}
            >
              {resultMessages[lastResult] || lastResult}
              {isSolo && lastResult === "incorrect" && soloProgress && (
                <span className="block mt-1 font-normal">
                  {soloProgress.strikesRemaining} strike{soloProgress.strikesRemaining === 1 ? "" : "s"} remaining.
                </span>
              )}
              {["incorrect", "solo_lost"].includes(lastResult) && lastFeedback?.message && (
                <span className="block mt-1 font-normal">
                  {lastFeedback.message}
                </span>
              )}
              {inTransition && roundTransition.countdown !== null && (
                <span className="ml-2 font-bold">
                  {isSolo ? `Next board in ${roundTransition.countdown}...` : `Next round in ${roundTransition.countdown}...`}
                </span>
              )}
            </div>
            {inTransition && roundTransition.countdown === null && (
              <div className="text-center mt-3">
                <button
                  onClick={() => {
                    const preserveResult = SOLO_TERMINAL_RESULTS.has(roundTransition.result);
                    setRoundTransition(null);
                    if (!preserveResult) {
                      setLastResult(null);
                      setLastFeedback(null);
                    }
                  }}
                  className="px-6 py-2.5 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all"
                >
                  {SOLO_TERMINAL_RESULTS.has(roundTransition.result) ? "See Result" : "Start New Round"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="w-full mb-2 animate-slide-down">
            <div className="p-2 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm text-center">
              {error}
            </div>
          </div>
        )}

        {/* Onboarding: objective, first-run how-to, clue legend */}
        <div className="w-full">
          <TicTacToeGuide />
        </div>
        {/* Board: full-width query container drives the height-aware cell var; the
            inner board shrinks to the grid's content width and stays centered. */}
        <div className="w-full animate-fade-in-up" style={boardSizingStyle}>
         <div className="mx-auto w-fit max-w-full">
          {/* Column headers */}
          <div className="grid gap-1.5 mb-1.5" style={boardGridStyle}>
            <div />
            {displayRound.columns.map((col, ci) => (
              <AxisLabel key={ci} axis={col} />
            ))}
          </div>

          {/* Rows */}
          {[0, 1, 2].map((ri) => (
            <div key={ri} className="grid gap-1.5 mb-1.5" style={boardGridStyle}>
              <AxisLabel axis={displayRound.rows[ri]} />
              {[0, 1, 2].map((ci) => {
                const cell = displayRound.cells.find(
                  (c) => c.row_index === ri && c.col_index === ci
                );
                const claimed = cell?.claimed_by_player;
                const isClickable =
                  !claimed &&
                  !inTransition &&
                  game.status === "active" &&
                  !game.pending_draw &&
                  isMyTurn;
                const showSamples =
                  inTransition && !claimed && cell?.sample_answers?.length > 0;
                const showClaimedSamples =
                  inTransition && claimed && cell?.sample_answers?.length > 0;

                let cellBg = "border-elq-border bg-white";
                if (claimed === 1) cellBg = "border-elq-player1/30 bg-elq-player1-bg";
                else if (claimed === 2) cellBg = "border-elq-player2/30 bg-elq-player2-bg";
                else if (isClickable) cellBg = "border-elq-border bg-white cursor-pointer group hover:border-elq-orange/50 hover:shadow-md active:bg-elq-orange/5 motion-safe:hover:scale-[1.02] motion-safe:active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange focus-visible:ring-offset-2 focus-visible:z-10";
                else if (showSamples) cellBg = "border-elq-border bg-sky-50/50";

                return (
                  <button
                    key={ci}
                    type="button"
                    onClick={() => isClickable && handleCellClick(cell)}
                    disabled={!isClickable}
                    className={`relative aspect-square rounded-xl border-2 flex items-center justify-center transition-all duration-200 text-center p-1.5 overflow-hidden min-w-0 ${cellBg}`}
                  >
                    {claimed ? (
                      <div className="animate-cell-claim flex flex-col items-center gap-0.5">
                        {cell.claimed_player_image_url && !inTransition && (
                          <img
                            src={optimizeHeadshot(cell.claimed_player_image_url, { width: HEADSHOT_WIDTHS.cell })}
                            alt={cell.claimed_player_name || ""}
                            className="w-6 h-6 rounded-full object-cover object-top border border-slate-200"
                            onError={(e) => handleHeadshotError(e, cell.claimed_player_image_url, (ev) => { ev.currentTarget.style.display = "none"; })}
                          />
                        )}
                        <div
                          className={`text-xs sm:text-sm font-bold truncate w-full ${
                            claimed === 1 ? "text-elq-player1" : "text-elq-player2"
                          }`}
                        >
                          {cell.claimed_player_name || `P${claimed}`}
                        </div>
                        {showClaimedSamples && (
                          <div className="mt-1 w-full space-y-0.5">
                            {cell.sample_answers.map((name, i) => (
                              <div
                                key={i}
                                className="text-[11px] not-italic text-elq-muted leading-tight truncate"
                              >
                                {name}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : showSamples ? (
                      <div className="w-full space-y-0.5">
                        {cell.sample_answers.map((name, i) => (
                          <div
                            key={i}
                            className="text-[11px] not-italic text-elq-muted leading-tight truncate"
                          >
                            {name}
                          </div>
                        ))}
                      </div>
                    ) : isClickable ? (
                      <span className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-full border-2 border-elq-orange-dark/40 text-elq-orange-dark text-2xl sm:text-3xl font-bold leading-none transition-colors group-hover:border-elq-orange-dark group-hover:bg-elq-orange/10">
                        +
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
         </div>
        </div>

        {/* Answer reveal button for solo mode */}
        {isSolo && game.status === "active" && !inTransition && (
          <div className="mt-4 text-center">
            <button
              onClick={handleGiveUp}
              disabled={loading}
              className="text-sm text-elq-muted hover:text-elq-text transition-colors underline underline-offset-2"
            >
              Show answers
            </button>
          </div>
        )}

        {/* Draw + resign controls. For online, "Offer Draw" and "Resign" share a
            single wrapping row so the board plus both controls fit a laptop
            viewport without scrolling (issue #259); the wider draw-response panel
            takes its own line via w-full. Local 1v1 shows only the draw control. */}
        {!isSolo && game.status === "active" && !inTransition && (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-center">
            {game.pending_draw ? (
              <div className="w-full bg-white rounded-xl border border-elq-border p-4 animate-slide-down">
                <p className="text-sm text-elq-text mb-3">
                  <strong>
                    {game.pending_draw.offered_by === 1
                      ? game.player1_name
                      : game.player2_name}
                  </strong>{" "}
                  offers a draw.{" "}
                  <strong>
                    {game.pending_draw.respond_to === 1
                      ? game.player1_name
                      : game.player2_name}
                  </strong>
                  , do you accept?
                </p>
                {(!isOnline || myPlayer === game.pending_draw.respond_to) && (
                  <div className="flex gap-3 justify-center">
                    <button
                      onClick={() => handleRespondDraw(true)}
                      disabled={loading}
                      className="px-5 py-2 bg-elq-success text-white font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => handleRespondDraw(false)}
                      disabled={loading}
                      className="px-5 py-2 bg-white border border-elq-border text-elq-text font-medium rounded-lg hover:bg-elq-bg transition-colors disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                )}
              </div>
            ) : (
              isMyTurn && (
                <button
                  onClick={handleOfferDraw}
                  disabled={loading}
                  className="text-sm text-elq-muted hover:text-elq-text transition-colors underline underline-offset-2"
                >
                  Offer Draw
                </button>
              )
            )}
            {isOnline && (
              <ResignControl onResign={handleResign} disabled={loading} inline />
            )}
          </div>
        )}
      </div>

      {/* Player search modal */}
      {selectedCell && game.status === "active" && !inTransition && (
        <PlayerSearch
          rowAxis={selectedCell.row_axis ?? round?.rows?.[selectedCell.row_index]}
          colAxis={selectedCell.col_axis ?? round?.columns?.[selectedCell.col_index]}
          onSelect={handlePlayerSelect}
          onCancel={() => setSelectedCell(null)}
        />
      )}
    </div>
  );
}
