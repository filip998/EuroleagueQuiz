import { useState, useEffect, useRef } from "react";
import { getGame, submitMove, offerDraw, respondDraw, giveUpGame, cancelQuickMatchTicTacToe, connectTicTacToeRealtime } from "./api";
import { REALTIME_CLIENT_ACTIONS } from "./realtimeSchema";
import { optimizeHeadshot, handleHeadshotError, HEADSHOT_WIDTHS } from "./imageUrl";
import { useOnlineGameRealtime } from "./useOnlineGameRealtime";
import PlayerSearch from "./PlayerSearch";
import BoardHeaderNav from "./BoardHeaderNav";
import { winnerDisplayName } from "./winnerName";
import OnlineScoreboard from "./OnlineScoreboard";
import ClubLogo from "./ClubLogo";
import WaitingLobby from "./WaitingLobby";
import ResignControl from "./ResignControl";
import QuickMatchSearchingLobby from "./QuickMatchSearchingLobby";
import TicTacToeGuide, { HowToPlayControl } from "./TicTacToeGuide";
import { useMediaQuery } from "./useMediaQuery";
import { buildInviteUrl } from "./inviteLink";
import { splitTrailingGroup } from "./labelWrap";
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

const RESULT_TONE_STYLES = {
  success: "border-emerald-300 bg-emerald-50 text-emerald-900",
  danger: "border-red-300 bg-red-50 text-red-900",
  neutral: "border-sky-300 bg-sky-50 text-sky-900",
  reveal: "border-orange-300 bg-orange-50 text-orange-950",
};

const SOLO_STRIKE_LIMIT = 3;
const SOLO_TOTAL_CELLS = 9;
const SOLO_TERMINAL_RESULTS = new Set(["solo_won", "solo_lost", "solo_drawn", "gave_up"]);
const ACCEPTED_MOVE_RESULTS = new Set([
  "correct",
  "round_won",
  "round_drawn",
  "match_won",
  "board_complete",
  "solo_won",
  "solo_drawn",
]);
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

function shortIncorrectFeedback(feedback) {
  const failedAxes = feedback?.failed_axes || [];
  if (failedAxes.length !== 1) return "No match for both clues";

  const label =
    failedAxes[0]?.display_label || failedAxes[0]?.label || "this clue";
  return label.length <= 18 ? `No ${label} match` : "Doesn’t match this clue";
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
      tone: "success",
    };
  }
  if (result === "solo_lost") {
    return {
      emoji: "❌",
      title: "Out of strikes",
      subtitle: `You used all ${progress.strikeLimit} strikes before completing a line.`,
      celebrate: false,
      tone: "danger",
    };
  }
  if (result === "solo_drawn") {
    return {
      emoji: "🤝",
      title: "Board complete",
      subtitle: "No three-in-a-row on the finished board.",
      celebrate: false,
      tone: "neutral",
    };
  }
  return {
    emoji: "👀",
    title: "Answers revealed",
    subtitle: "Study the board, then try again when you are ready.",
    celebrate: false,
    tone: "reveal",
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
  // Keep the trailing two characters of a long label unbreakable so the narrow
  // mobile grid tracks can't strand a single letter on the last line (#265).
  const { head, tail } = splitTrailingGroup(label);
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
        <span className="text-[9px] font-bold uppercase tracking-wide leading-none">
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
        {head}
        {tail ? <span className="whitespace-nowrap">{tail}</span> : null}
      </span>
    </div>
  );
}

export default function GameBoard({ initialState, onNewGame, onHome, onlineInfo }) {
  const initialGame = initialState?.game || initialState;
  const [game, setGame] = useState(initialGame);
  const [terminalRound, setTerminalRound] = useState(
    initialGame?.status === "finished" ? initialGame.round : null
  );
  const [selectedCell, setSelectedCell] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [lastFeedback, setLastFeedback] = useState(null);
  const [cellFeedback, setCellFeedback] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const [roundTransition, setRoundTransition] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const attemptedCellRef = useRef(null);
  // Synchronous guard against a second move firing before the first settles.
  // React state (e.g. `selectedCell`/`loading`) only takes effect on the next
  // render, so a second PlayerSearch activation in the same tick (fast
  // double-tap/double-Enter before the closing re-render lands) could still
  // read the stale `selectedCell` and dispatch another submitMove/realtime
  // move. A ref is mutated immediately and closes that window.
  const pendingMoveRef = useRef(false);
  // Reactive mirror of pendingMoveRef so the board can visibly/accessibly
  // reflect "a move is in flight" (cells stop looking clickable, aria-disabled
  // while the request is outstanding) without ever gating the native
  // `disabled` attribute on it -- see isClickable/baseClickable below, which
  // keep the attempted cell's button focusable so focus restoration from the
  // closing PlayerSearch dialog has somewhere to land.
  const [movePending, setMovePending] = useState(false);
  // A cell that just became permanently unfocusable (claimed, or the game
  // ended) can silently blur to <body> the instant its `disabled` attribute
  // flips true, if the user was still focused on it via keyboard. When that
  // is detected, this records where focus should land instead: "board" (a
  // stable, always-focusable board region -- the game continues, just not on
  // this exact cell anymore) or "finished" (the terminal Play Again action).
  // Set by handleRealtimeState, applied and cleared by the effect below.
  const [focusRecoveryTarget, setFocusRecoveryTarget] = useState(null);
  const boardRegionRef = useRef(null);
  const primaryResultActionRef = useRef(null);
  // The actual DOM node of the cell button that opened PlayerSearch, captured
  // explicitly at click time (not inferred from document.activeElement).
  // Safari/iOS Safari and Firefox on macOS commonly do NOT move focus to a
  // button on a plain pointer/tap, so relying on activeElement alone would
  // capture <body> as the "opener" there and never restore to the real
  // trigger. Passed to PlayerSearch as an explicit, deterministic triggerRef.
  const selectedCellTriggerRef = useRef(null);

  const isSolo = game?.mode === "single_player";
  // A solo / local game must never be treated as online, even if `onlineInfo`
  // carries a stale seat recovered for a reused game id (see onlineRecovery.js).
  const isOnline = game?.mode === "online_friend" && Boolean(onlineInfo?.isOnline);
  // Desktop Solo gets the left command rail + board pane layout (issue #266); the
  // hook is matchMedia-guarded so it resolves to false in jsdom, keeping every
  // existing test (and mobile/local/online) on the stacked column. Called here,
  // before any early return, so hook order is stable across renders.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isSoloDesktop = isSolo && isDesktop;
  const myPlayer = onlineInfo?.playerNumber;
  const realtimeUnavailableMessage = "Realtime connection unavailable. Reconnecting...";

  // The ONE place that decides whether the attempted cell's button will
  // remain a real, natively-enabled control under an INCOMING authoritative
  // state -- rather than inferring it from the result token (e.g. "incorrect
  // stays focusable"), which breaks the moment the two diverge. They do
  // diverge online: an incorrect guess still switches `current_player` to
  // the opponent, so the same "incorrect" result that leaves a Local/Solo
  // cell clickable makes an online cell natively disabled via isMyTurn. The
  // same authoritative check applies whether this update carries a result
  // (a direct response to our own move) or is a background poll resync
  // (result: null) that happens to reveal the same turn/claim change because
  // our own move's result broadcast was lost. Mirrors baseClickable's
  // structural conditions below, evaluated against the NEW state instead of
  // the current one.
  function willAttemptedCellRemainFocusable(incomingState, attemptedCell, willTransition) {
    if (!incomingState || !attemptedCell || willTransition) return false;
    if (incomingState.status !== "active") return false;
    if (incomingState.pending_draw) return false;
    if (isOnline && incomingState.current_player !== myPlayer) return false;
    const cells = incomingState.round?.cells || [];
    const cell = cells.find(
      (c) =>
        c.row_index === attemptedCell.row_index && c.col_index === attemptedCell.col_index
    );
    return !cell?.claimed_by_player;
  }

  // Single place that arms the pending-move guard (ref + reactive mirror) so
  // every release path stays in lockstep.
  function beginPendingMove(attemptedCell) {
    attemptedCellRef.current = attemptedCell;
    pendingMoveRef.current = true;
    setMovePending(true);
  }

  // Single place that clears the pending-move guard. Called whenever we have
  // proof the outstanding move can no longer be waited on: a state broadcast
  // that actually carries a result, a realtime error (the move was rejected
  // or the connection dropped before/after sending it), a failed send, an
  // HTTP rejection, or -- as a bounded fallback for a broadcast that was lost
  // in transit -- the next authoritative poll resync (see handleRealtimeState).
  function releasePendingMove() {
    attemptedCellRef.current = null;
    pendingMoveRef.current = false;
    setMovePending(false);
  }

  function handleRealtimeState(message) {
    const result = message.result;
    const feedback = message.feedback || null;
    const attemptedCell = attemptedCellRef.current;

    // Decide BEFORE mutating any state whether the attempted cell's button
    // is about to stop being a real, natively-enabled control -- claimed for
    // good, the game/round no longer active, blocked by a pending draw, or
    // (online) no longer this player's turn -- using the authoritative
    // INCOMING state (see willAttemptedCellRemainFocusable above), not just
    // the result token. This runs for BOTH a direct response to our own move
    // AND a background poll resync (message.source === "poll", result: null)
    // that can reveal the exact same turn/claim change if our own move's
    // result broadcast was lost in transit. If keyboard focus is currently
    // on that exact cell and it's not staying enabled, arm a recovery target
    // so the effect above moves focus somewhere stable/meaningful once the
    // DOM reflects the change, instead of silently losing it to <body> the
    // instant `disabled` flips true.
    if (attemptedCell) {
      const willTransition = Boolean(message.completedRound) && ROUND_REVEAL_RESULTS.has(result);
      const staysFocusable = willAttemptedCellRemainFocusable(
        message.state,
        attemptedCell,
        willTransition
      );
      if (!staysFocusable) {
        const attemptedButton = document.querySelector(
          `[data-row-index="${attemptedCell.row_index}"][data-col-index="${attemptedCell.col_index}"]`
        );
        if (attemptedButton && document.activeElement === attemptedButton) {
          setFocusRecoveryTarget(message.state?.status === "finished" ? "finished" : "board");
        }
      }
    }

    setGame(message.state);
    if (message.state?.status === "finished") {
      setTerminalRound(message.completedRound || message.state.round || null);
    }
    setError(null);

    if (attemptedCell && result === "incorrect") {
      setCellFeedback({
        ...attemptedCell,
        kind: "incorrect",
        message: shortIncorrectFeedback(feedback),
      });
    } else if (attemptedCell && ACCEPTED_MOVE_RESULTS.has(result)) {
      setCellFeedback({ ...attemptedCell, kind: "correct", phase: "check" });
    }
    if (result) {
      releasePendingMove();
    } else if (message.source === "poll" && pendingMoveRef.current) {
      // Bounded recovery: this is the periodic authoritative GET /games/{id}
      // resync (see useOnlineGameRealtime), not a targeted broadcast for our
      // move. If a move is still marked pending by the time it lands, the
      // move's own result broadcast was lost (or the socket dropped and
      // reconnected without replaying it) -- release the guard so the player
      // is never soft-locked waiting for a reply that will never arrive. The
      // resync already reflects whatever actually happened on the server, so
      // there is nothing further to reconcile here beyond unblocking input.
      releasePendingMove();
    }

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

  // A server-rejected move (claimed cell, player not found, a pending draw
  // that raced ahead, ...) arrives as a realtime ERROR envelope tagged
  // { source: "realtime" } by useOnlineGameRealtime, not a state/result
  // broadcast, so it would never reach handleRealtimeState's result-based
  // release above. Routing every REALTIME error through the same release
  // keeps a retryable rejection (or a dropped connection) from ever
  // soft-locking the board; releasing when nothing is pending is a no-op.
  //
  // A background POLL failure (source: "poll") is a different thing
  // entirely: it is just a transient GET hiccup fetching the periodic
  // authoritative resync, unrelated to whether any specific action was
  // accepted or rejected. Treating it as a move rejection would release the
  // guard for a move that may still be perfectly in flight, opening the door
  // to a second move sending while the first is still outstanding. Only
  // surface it as a connection message; never release on it.
  function handleRealtimeError(message, meta) {
    if (meta?.source !== "poll") {
      releasePendingMove();
    }
    setError(message);
  }

  const realtime = useOnlineGameRealtime({
    enabled: isOnline,
    gameId: game?.id,
    gameStatus: game?.status,
    playerNumber: myPlayer,
    connect: connectTicTacToeRealtime,
    fetchState: getGame,
    onState: handleRealtimeState,
    onError: handleRealtimeError,
  });

  const round = game?.round;
  const soloProgress = isSolo ? buildSoloProgress(game, round) : null;

  useEffect(() => {
    if (!cellFeedback) return undefined;
    const timer =
      cellFeedback.kind === "correct" && cellFeedback.phase === "check"
        ? setTimeout(
            () =>
              setCellFeedback((current) =>
                current?.kind === "correct"
                  ? { ...current, phase: "headshot" }
                  : current
              ),
            380
          )
        : setTimeout(
            () => setCellFeedback(null),
            cellFeedback.kind === "correct" ? 480 : 2400
          );
    return () => clearTimeout(timer);
  }, [cellFeedback]);

  // Mirrors `showFinishedResult` (computed further below, after this
  // component's early-return gates) using only state already available this
  // early -- hooks must run unconditionally on every render, so this effect
  // has to sit above those gates and can't reference a `const` declared after
  // them.
  const isShowingFinishedResult = game?.status === "finished" && !roundTransition;

  // Runs after the render where the attempted cell's button actually became
  // disabled (see handleRealtimeState below, which decides IF/where to
  // recover focus to). Deferred to an effect rather than done inline so the
  // recovery target (board region / Play Again button) is guaranteed to
  // already exist in the DOM for the render it needs to apply to.
  useEffect(() => {
    if (!focusRecoveryTarget) return;
    if (focusRecoveryTarget === "board") {
      boardRegionRef.current?.focus();
      setFocusRecoveryTarget(null);
      return;
    }
    // focusRecoveryTarget === "finished": a correct claim or a game-ending
    // result just arrived, but the game can still be sitting behind a
    // "Next round in N..." transition banner (e.g. match_won) for several
    // seconds before the terminal Play Again screen actually mounts. Hold
    // focus on the still-rendered board in the meantime; this effect
    // re-runs once isShowingFinishedResult flips, which is when the actual
    // handoff below happens.
    if (!isShowingFinishedResult) {
      boardRegionRef.current?.focus();
      return;
    }
    // The terminal screen just mounted. A multi-second countdown was a real
    // window for the user to deliberately move focus elsewhere (e.g. tab to
    // or click the persistent Home control) -- only claim Play Again if
    // focus is still exactly where this recovery left it (the board region),
    // on <body> (the browser's own blur-on-disable, not a deliberate user
    // choice), or nowhere connected at all. Otherwise respect wherever the
    // user actually put their focus and just clear the target.
    const active = document.activeElement;
    const userMovedFocusDeliberately =
      active instanceof HTMLElement &&
      active.isConnected &&
      active !== document.body &&
      active !== boardRegionRef.current;
    if (!userMovedFocusDeliberately) {
      primaryResultActionRef.current?.focus();
    }
    setFocusRecoveryTarget(null);
  }, [focusRecoveryTarget, isShowingFinishedResult]);

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
    if (roundTransition.countdown == null) return; // defensive: transitions always carry a numeric countdown
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
    // Solo terminal results (solo_won/solo_lost/solo_drawn/gave_up) only occur in
    // single_player mode and skip the "See Result" gate: the finished game state
    // already carries the revealed round, so we record the result and let the
    // solo board-backed result render immediately instead of pausing on a banner.
    if (SOLO_TERMINAL_RESULTS.has(result)) {
      setLastResult(result);
      setLastFeedback(feedback);
      setSelectedCell(null);
      return;
    }
    if (completedRound) {
      setRoundTransition({ countdown: 3, completedRound, result });
    }
    setLastResult(result);
    setLastFeedback(feedback);
    setSelectedCell(null);
  }

  function handleCellClick(cell, triggerElement) {
    if (game.status !== "active") return;
    if (cell.claimed_by_player) return;
    if (game.pending_draw) return;
    if (isOnline && game.current_player !== myPlayer) return;
    selectedCellTriggerRef.current = triggerElement instanceof HTMLElement ? triggerElement : null;
    setSelectedCell(cell);
    setError(null);
    setLastResult(null);
    setLastFeedback(null);
    setCellFeedback(null);
  }

  async function handlePlayerSelect(player) {
    // Bail out synchronously if a move is already in flight (online: waiting
    // on the realtime broadcast; local/HTTP: waiting on submitMove) so a rapid
    // second PlayerSearch activation can never issue a second move.
    if (!selectedCell || pendingMoveRef.current) return;
    const attemptedCell = {
      row_index: selectedCell.row_index,
      col_index: selectedCell.col_index,
    };
    beginPendingMove(attemptedCell);
    setSelectedCell(null);
    setLoading(true);
    setError(null);
    try {
      if (isOnline) {
        const sent = realtime.sendAction(REALTIME_CLIENT_ACTIONS.MOVE, {
          row_index: attemptedCell.row_index,
          col_index: attemptedCell.col_index,
          player_id: player.player_id,
        });
        if (!sent) {
          releasePendingMove();
          setError(realtimeUnavailableMessage);
        }
        // On success the guard stays engaged until the realtime broadcast (or
        // a realtime error, or a bounded poll resync) releases it -- see
        // handleRealtimeState/handleRealtimeError.
        return;
      }

      const res = await submitMove(game.id, {
        row_index: attemptedCell.row_index,
        col_index: attemptedCell.col_index,
        player_id: player.player_id,
      });
      handleRealtimeState(res);
    } catch (err) {
      releasePendingMove();
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
      // Solo give-up returns a finished game with the revealed round; route it
      // through the shared handler so it lands on the result screen with no gate.
      handleRealtimeState(res);
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

  const inTransition = !!roundTransition;
  const showFinishedResult = game.status === "finished" && !inTransition;
  const displayRound =
    (game.status === "finished" ? terminalRound : null) ||
    roundTransition?.completedRound ||
    round;

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
  //
  // Desktop Solo (issue #266) moves the scoreboard, feedback and guide into the
  // left command rail, so the only chrome above the board pane is the page header
  // + the column-header row. That frees a lot of vertical space, so the reserve
  // drops sharply and the per-cell cap is raised to use the freed height/width.
  const boardReserve = showFinishedResult
    ? "330px"
    : isSoloDesktop
    ? "230px"
    : isSolo
      ? "306px"
      : isOnline
        ? "340px"
        : "326px";
  const boardCellMax = showFinishedResult
    ? "150px"
    : isSoloDesktop
      ? "240px"
      : "176px";
  const boardSizingStyle = {
    animationDelay: "100ms",
    containerType: "inline-size",
    // Issue #293: fold the auth top-reserve into the board's vertical budget so
    // the page header can shift down by the safe-area band without forcing the
    // board to scroll. `--elq-auth-safe-top` is 0px when auth is off, so the
    // sizing math is identical for anonymous builds.
    "--ttt-reserve": `calc(${boardReserve} + var(--elq-auth-safe-top, 0px))`,
    "--ttt-axis": "clamp(72px, 14cqw, 92px)",
    "--ttt-cell": `min(calc((100cqw - var(--ttt-axis) - 18px) / 3), clamp(72px, calc((100svh - var(--ttt-reserve)) / 3), ${boardCellMax}))`,
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

  let finishedPresentation = null;
  if (showFinishedResult && isSolo) {
    finishedPresentation = soloResultPresentation(
      game,
      soloProgress,
      lastResult,
      displayRound
    );
  } else if (showFinishedResult) {
    const finishedWinnerName = winnerDisplayName(game);
    finishedPresentation = {
      emoji: finishedWinnerName ? "\ud83c\udfc6" : "\ud83e\udd1d",
      title: finishedWinnerName ? `${finishedWinnerName} WINS!` : "No winner",
      subtitle: finishedSubtitle,
      tone:
        game.winner_player == null
          ? "neutral"
          : iWon || !isOnline
            ? "success"
            : "danger",
    };
  }

  // Render fragments shared by the stacked column (mobile Solo, Local 1v1,
  // Online) and the desktop Solo command rail (issue #266). Each is built once
  // and referenced from a single live layout branch, so unscoped test queries
  // (e.g. getByText("Show answers")) never match duplicate nodes.
  const soloProgressCard = isSolo ? (
    <div
      className="mb-3 grid min-h-[84px] w-full grid-cols-3 overflow-hidden rounded-2xl border border-elq-border bg-white shadow-sm animate-fade-in-up"
      aria-label="TicTacToe solo progress"
    >
      <div className="flex min-w-0 flex-col items-center justify-center px-2 py-2 text-center">
        <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-elq-muted">
          Claimed
        </div>
        <div className="font-display text-3xl font-bold leading-none text-emerald-700">
          {soloProgress.claimedCells}/{soloProgress.totalCells}
        </div>
        {soloProgress.boardsWon > 0 && (
          <span className="sr-only">Boards won: {soloProgress.boardsWon}</span>
        )}
      </div>

      <div className="flex min-w-0 flex-col items-center justify-center border-x border-elq-border px-2 py-2 text-center">
        <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-elq-muted">
          Goal
        </div>
        <div aria-hidden="true" className="mt-1 flex gap-1">
          <span className="h-3 w-3 rounded-sm bg-elq-cta" />
          <span className="h-3 w-3 rounded-sm bg-elq-cta" />
          <span className="h-3 w-3 rounded-sm bg-elq-cta" />
        </div>
        <div className="mt-1 text-[10px] font-semibold leading-none text-elq-dark">
          Three in a row
        </div>
      </div>

      <div className="flex min-w-0 flex-col items-center justify-center px-2 py-2 text-center">
        <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-elq-muted">
          Strikes
        </div>
        <div
          className="mt-1 flex items-center justify-center gap-1"
          role="img"
          aria-label={`${soloProgress.strikesUsed} of ${soloProgress.strikeLimit} strikes used, ${soloProgress.strikesRemaining} remaining`}
        >
          {Array.from({ length: soloProgress.strikeLimit }).map((_, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-full border-2 ${
                index < soloProgress.strikesUsed
                  ? "border-red-600 bg-red-600"
                  : "border-slate-300 bg-transparent"
              }`}
            />
          ))}
          <span
            aria-hidden="true"
            className={`ml-1 text-xs font-bold ${
              soloProgress.strikesRemaining <= 1 ? "text-red-700" : "text-elq-dark"
            }`}
          >
            {soloProgress.strikesRemaining} left
          </span>
        </div>
      </div>
    </div>
  ) : null;

  const onlineScoreboard = !isSolo ? (
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
            : isOnline && !isMyTurn
              ? "Waiting for opponent..."
            : `${currentPlayerName}'s turn`
        }
        compact
      />
    </div>
  ) : null;

  const feedbackBanner =
   lastResult &&
   !["resigned", "opponent_left", "correct", "incorrect"].includes(lastResult) ? (
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
          {inTransition && (
            <span className="ml-2 font-bold">
              {isSolo ? `Next board in ${roundTransition.countdown}...` : `Next round in ${roundTransition.countdown}...`}
            </span>
          )}
        </div>
      </div>
    ) : null;

  const errorBanner = error ? (
    <div className="w-full mb-2 animate-slide-down">
      <div className="p-2 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm text-center">
        {error}
      </div>
    </div>
  ) : null;

  // Board: full-width query container drives the height-aware cell var; the inner
  // board shrinks to the grid's content width and stays centered.
  const boardPane = (
    <div className="w-full animate-fade-in-up" style={boardSizingStyle}>
      <div
        ref={boardRegionRef}
        tabIndex={-1}
        aria-label="TicTacToe board"
        className="mx-auto w-fit max-w-full outline-none"
      >
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
              const activeCellFeedback =
                cellFeedback?.row_index === ri && cellFeedback?.col_index === ci
                  ? cellFeedback
                  : null;
              // baseClickable covers every reason a cell is PERMANENTLY
              // inert for the rest of this round (claimed, mid-transition,
              // game not active, blocked by a pending draw, not this
              // player's turn) and drives the native `disabled` attribute
              // below. Two things are intentionally kept OUT of it, both
              // transient/reversible rather than structural:
              //   - `movePending`/`loading`: a move is in flight for THIS
              //     cell (online broadcast, or local/HTTP submitMove).
              //   - an "incorrect" activeCellFeedback: the guess was wrong,
              //     but the cell was never claimed, so it goes right back to
              //     being clickable once the ~2.4s feedback window clears.
              // Gating `disabled` on either would make the just-attempted
              // cell's button unfocusable the instant it happens (mid-render,
              // same commit as the state update), so:
              //   - useDialogFocus's opener-focus restoration (when
              //     PlayerSearch unmounts) would silently no-op, and
              //   - a wrong guess would force an unnecessary focus recovery
              //     every single time instead of just staying put.
              // Blocking activation (via isClickable/onClick) and surfacing
              // aria-disabled is enough to keep the board from looking or
              // acting interactive while transiently blocked, without
              // sacrificing focus. A cell that becomes claimed (correct) or a
              // game/round that stops being active DOES permanently drop out
              // of baseClickable -- handleRealtimeState's focus-recovery
              // above is what keeps keyboard focus from being lost to <body>
              // in that genuinely-permanent case.
              const transientlyBlocked =
                movePending || loading || activeCellFeedback?.kind === "incorrect";
              const baseClickable =
                !claimed &&
                !inTransition &&
                game.status === "active" &&
                !game.pending_draw &&
                isMyTurn;
              const isClickable = baseClickable && !transientlyBlocked;
              const showSamples =
                (inTransition || showFinishedResult) &&
                !claimed &&
                cell?.sample_answers?.length > 0;
              const showClaimedSamples =
                (inTransition || showFinishedResult) &&
                claimed &&
                cell?.sample_answers?.length > 0;
              const showCorrectFeedback =
                !showFinishedResult &&
                claimed &&
                activeCellFeedback?.kind === "correct";

              // Solo has no opponent, so a claimed cell uses a neutral/positive
              // green accent instead of the Player-1 blue identity color (which
              // implies a second player). Local 1v1 / Online keep blue/red.
              let cellBg = "border-elq-border bg-white";
              if (!claimed && activeCellFeedback?.kind === "incorrect") {
                cellBg = "border-red-300 bg-red-50";
              } else if (isSolo && claimed) cellBg = "border-emerald-600/30 bg-emerald-100";
              else if (claimed === 1) cellBg = "border-elq-player1/30 bg-elq-player1-bg";
              else if (claimed === 2) cellBg = "border-elq-player2/30 bg-elq-player2-bg";
              else if (isClickable) cellBg = "border-elq-border bg-white cursor-pointer group hover:border-elq-orange/50 hover:shadow-md active:bg-elq-orange/5 motion-safe:hover:scale-[1.02] motion-safe:active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange focus-visible:ring-offset-2 focus-visible:z-10";
              else if (showSamples) {
                cellBg = showFinishedResult
                  ? "border-emerald-300 bg-emerald-50/70"
                  : "border-elq-border bg-sky-50/50";
              }
              if (showCorrectFeedback) {
                cellBg += " ring-2 ring-emerald-400/70";
              }

              const rowLabel = clueText(displayRound.rows[ri]);
              const colLabel = clueText(displayRound.columns[ci]);
              // True whenever the cell is transiently (not permanently)
              // blocked: aria-disabled should say so regardless of which
              // transient reason applies, but the "Move in progress" wording
              // below only ever surfaces when nothing more specific (like
              // the "Incorrect. ..." branch, checked first) already covers it.
              const pendingBlocked = baseClickable && transientlyBlocked;
              const stateLabel = claimed
                ? `Claimed by ${cell.claimed_player_name || `player ${claimed}`}`
                : activeCellFeedback?.kind === "incorrect"
                  ? `Incorrect. ${activeCellFeedback.message}`
                  : showSamples
                    ? `Example answers: ${cell.sample_answers.join(", ")}`
                    : showFinishedResult
                      ? "No example available"
                    : isClickable
                      ? "Available. Choose a player"
                      : pendingBlocked
                        ? "Available. Move in progress"
                        : "Available";

              return (
                <button
                  key={ci}
                  type="button"
                  onClick={(event) => isClickable && handleCellClick(cell, event.currentTarget)}
                  disabled={!baseClickable}
                  aria-disabled={pendingBlocked ? "true" : undefined}
                  aria-label={`${rowLabel} row and ${colLabel} column. ${stateLabel}.`}
                  data-row-index={ri}
                  data-col-index={ci}
                  className={`relative aspect-square rounded-xl border-2 flex items-center justify-center transition-all duration-200 text-center p-1.5 overflow-hidden min-w-0 ${cellBg}`}
                >
                  {claimed ? (
                    <div className="animate-cell-claim flex flex-col items-center gap-0.5 w-full min-w-0">
                      {(showCorrectFeedback ||
                        (cell.claimed_player_image_url &&
                          !inTransition &&
                          !showFinishedResult)) && (
                        <span className="relative block h-7 w-7 shrink-0">
                          {cell.claimed_player_image_url &&
                            !inTransition &&
                            !showFinishedResult && (
                              <img
                                src={optimizeHeadshot(cell.claimed_player_image_url, { width: HEADSHOT_WIDTHS.cell })}
                                alt={cell.claimed_player_name || ""}
                                className={`ttt-claimed-headshot absolute inset-0 h-7 w-7 rounded-full border border-slate-200 object-cover object-top ${
                                  showCorrectFeedback &&
                                  activeCellFeedback.phase === "check"
                                    ? "opacity-0"
                                    : showCorrectFeedback
                                      ? "ttt-headshot-reveal"
                                      : ""
                                }`}
                                onError={(e) => handleHeadshotError(e, cell.claimed_player_image_url, (ev) => { ev.currentTarget.style.display = "none"; })}
                              />
                            )}
                          {showCorrectFeedback && (
                            <span
                              aria-hidden="true"
                              className={`ttt-correct-check absolute inset-0 flex items-center justify-center rounded-full bg-emerald-600 text-base font-bold text-white ${
                                activeCellFeedback.phase === "headshot"
                                  ? "ttt-correct-check-exit"
                                  : "ttt-correct-check-enter"
                              }`}
                            >
                              ✓
                            </span>
                          )}
                        </span>
                      )}
                      <div
                        className={`ttt-claimed-name w-full min-w-0 font-bold capitalize ${
                          isSolo && claimed
                            ? "text-emerald-800"
                            : claimed === 1
                              ? "text-elq-player1"
                              : "text-elq-player2"
                        }`}
                      >
                        {cell.claimed_player_name || `P${claimed}`}
                      </div>
                      {showClaimedSamples && (
                        <div aria-hidden="true" className="mt-1 w-full space-y-0.5">
                          {cell.sample_answers.slice(0, 2).map((name, i) => (
                            <div
                              key={i}
                              className={`truncate text-[10px] not-italic capitalize leading-tight ${
                                isSolo ? "text-emerald-700" : "text-elq-muted"
                              }`}
                            >
                              {name}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : activeCellFeedback?.kind === "incorrect" ? (
                    <div className="flex w-full min-w-0 flex-col items-center gap-1 text-red-700">
                      <span
                        aria-hidden="true"
                        className="flex h-6 w-6 items-center justify-center rounded-full bg-red-100 text-sm font-bold"
                      >
                        ×
                      </span>
                      <span className="max-w-full text-[10px] font-bold leading-tight">
                        {activeCellFeedback.message}
                      </span>
                    </div>
                  ) : showSamples ? (
                    <div aria-hidden="true" className="w-full space-y-0.5">
                      {cell.sample_answers.slice(0, 3).map((name, i) => (
                        <div
                          key={i}
                          className={`truncate not-italic capitalize leading-tight tracking-tight ${
                            i === 0
                              ? "text-[10px] font-semibold text-elq-text"
                              : "text-[9px] text-elq-muted"
                          }`}
                        >
                          {name}
                        </div>
                      ))}
                    </div>
                  ) : showFinishedResult ? (
                    <span aria-hidden="true" className="text-lg text-slate-300">
                      —
                    </span>
                  ) : (
                    <span
                      aria-hidden="true"
                      className={`flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-full border-2 text-2xl sm:text-3xl font-bold leading-none transition-colors ${
                        isClickable
                          ? "border-elq-orange-dark/40 text-elq-orange-dark group-hover:border-elq-orange-dark group-hover:bg-elq-orange/10"
                          : "border-slate-200 text-slate-300"
                      }`}
                    >
                      +
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  const showAnswersButton = (
    <button
      onClick={handleGiveUp}
      disabled={loading}
      className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm text-elq-muted underline underline-offset-2 transition-colors hover:text-elq-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange"
    >
      Show answers
    </button>
  );

  const drawResignControls =
    !isSolo && game.status === "active" && !inTransition ? (
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
              className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm text-elq-muted underline underline-offset-2 transition-colors hover:text-elq-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange"
            >
              Offer Draw
            </button>
          )
        )}
        {isOnline && (
          <ResignControl onResign={handleResign} disabled={loading} inline />
        )}
      </div>
    ) : null;

  const finishedSummary = finishedPresentation ? (
    <div
      className={`mb-3 flex items-center gap-3 rounded-2xl border p-3 shadow-sm ${
        RESULT_TONE_STYLES[finishedPresentation.tone] || RESULT_TONE_STYLES.reveal
      }`}
    >
      <span
        aria-hidden="true"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/70 text-2xl"
      >
        {finishedPresentation.emoji}
      </span>
      <div className="min-w-0">
        <h1 className="text-xl font-bold leading-tight">
          {finishedPresentation.title}
        </h1>
        <p className="mt-0.5 text-sm opacity-75">
          {finishedPresentation.subtitle}
        </p>
      </div>
    </div>
  ) : null;

  const finishedActions = showFinishedResult ? (
    <div className="mt-3 grid grid-cols-[1.35fr_1fr] gap-2">
      <button
        ref={primaryResultActionRef}
        type="button"
        onClick={onNewGame}
        className="min-h-12 rounded-xl bg-elq-cta px-4 text-sm font-bold text-white transition-colors hover:bg-elq-cta-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange focus-visible:ring-offset-2"
      >
        Play Again
      </button>
      <button
        type="button"
        onClick={onHome}
        className="min-h-12 rounded-xl border border-elq-border bg-white px-4 text-sm font-bold text-elq-dark transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange focus-visible:ring-offset-2"
      >
        Home
      </button>
    </div>
  ) : null;

  const modeLabel = isSolo
    ? "Solo"
    : game.mode === "local_two_player"
      ? "Local 1v1"
      : "Online";
  const liveAnnouncement = lastResult
    ? [
        // Terminal forfeit results have no generic phrasing in resultMessages;
        // prefer the perspective-aware reason ("You resigned." / "Your opponent
        // left the game.") already computed above so the live region never reads
        // out the raw result key ("resigned", "opponent_left") to screen readers.
        finishedReason || resultMessages[lastResult] || lastResult,
        lastFeedback?.message,
        game.status === "active" ? `${currentPlayerName}'s turn.` : null,
      ]
        .filter(Boolean)
        .join(" ")
    : game.status === "active"
      ? `${currentPlayerName}'s turn.`
      : "";

  return (
    <div className="elq-auth-safe-top min-h-screen flex flex-col">
      <div className="h-1 bg-elq-orange" />

      <div className="bg-white border-b border-elq-border">
        <div
          className={`${
            isSoloDesktop ? "max-w-6xl" : "max-w-2xl"
          } mx-auto grid min-h-12 grid-cols-[1fr_auto_1fr] items-center px-4`}
        >
          <BoardHeaderNav onHome={onHome} className="-ml-2 min-h-11 px-2" />
          <span
            data-testid="ttt-mode-indicator"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-elq-text"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                game.mode === "online_friend" ? "bg-emerald-500" : "bg-elq-orange"
              }`}
              aria-hidden="true"
            />
            {modeLabel}
          </span>
          <span />
        </div>
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      {showFinishedResult ? (
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-3">
          {finishedSummary}
          {boardPane}
          <p className="mt-1 text-center text-xs text-elq-muted">
            Examples are not the only valid answers.
          </p>
          {finishedActions}
        </main>
      ) : isSoloDesktop ? (
        <div className="flex-1 min-h-0 w-full max-w-6xl mx-auto flex gap-6 px-4 py-4">
          {/* Left command rail: objective + progress pinned top, transient
              feedback/error in a bounded scroll area (so a long banner can never
              push the board below the fold), and how-to + show-answers pinned to
              the bottom. Desktop Solo only — issue #266. */}
          <aside
            className="flex w-[280px] shrink-0 flex-col min-h-0"
            aria-label="TicTacToe solo command rail"
          >
            <div className="shrink-0">{soloProgressCard}</div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {feedbackBanner}
              {errorBanner}
            </div>
            <div className="shrink-0 mt-3 flex flex-col items-start gap-3 border-t border-elq-border pt-3">
              <HowToPlayControl fallbackFocusRef={boardRegionRef} />
              {game.status === "active" && !inTransition && showAnswersButton}
            </div>
          </aside>
          {/* Board pane fills the freed width; the board sizes against the viewport
              height (boardSizingStyle) and stays centered. */}
          <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center">
            {boardPane}
          </div>
        </div>
      ) : (
      <div className="flex-1 flex flex-col items-center px-4 py-2 sm:py-3 max-w-2xl mx-auto w-full">
        {/* Scoreboard */}
        {isSolo ? soloProgressCard : onlineScoreboard}

        {/* Result banner */}
        {feedbackBanner}

        {/* Error */}
        {errorBanner}

        {/* Objective and the combined Help sheet */}
        <div className="w-full">
          <TicTacToeGuide fallbackFocusRef={boardRegionRef} />
        </div>
        {/* Board */}
        {boardPane}

        {/* Answer reveal button for solo mode */}
        {isSolo && game.status === "active" && !inTransition && (
          <div className="mt-2 text-center">{showAnswersButton}</div>
        )}

        {/* Draw + resign controls (online / local 1v1) */}
        {drawResignControls}
      </div>
      )}

      {/* Player search modal */}
      {selectedCell && game.status === "active" && !inTransition && (
        <PlayerSearch
          rowAxis={selectedCell.row_axis ?? round?.rows?.[selectedCell.row_index]}
          colAxis={selectedCell.col_axis ?? round?.columns?.[selectedCell.col_index]}
          onSelect={handlePlayerSelect}
          onCancel={() => setSelectedCell(null)}
          // Explicit opener: deterministic regardless of whether the browser
          // actually moved focus to the clicked cell (Safari/Firefox commonly
          // don't on a plain pointer/tap).
          triggerRef={selectedCellTriggerRef}
          // If a realtime update (turn change, claim, ...) disables the
          // opener cell while this dialog is open on top of it, restoring
          // focus there on close would silently no-op -- fall back to the
          // stable board region instead of losing focus to <body>.
          fallbackFocusRef={boardRegionRef}
        />
      )}
    </div>
  );
}
