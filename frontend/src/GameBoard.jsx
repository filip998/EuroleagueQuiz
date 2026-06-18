import { useState, useEffect } from "react";
import { getGame, submitMove, offerDraw, respondDraw, giveUpGame, cancelQuickMatchTicTacToe, connectTicTacToeRealtime } from "./api";
import { REALTIME_CLIENT_ACTIONS } from "./realtimeSchema";
import { useOnlineGameRealtime } from "./useOnlineGameRealtime";
import PlayerSearch from "./PlayerSearch";
import BoardHeaderNav from "./BoardHeaderNav";
import OnlineScoreboard from "./OnlineScoreboard";
import ClubLogo from "./ClubLogo";
import WaitingLobby from "./WaitingLobby";
import QuickMatchSearchingLobby from "./QuickMatchSearchingLobby";
import { buildInviteUrl } from "./inviteLink";
import { clearOnlineInfo } from "./onlineRecovery";
import { forgetQuickMatchSeat } from "./quickMatchSeats";

function AxisLabel({ axis }) {
  const isTeam = axis.axis_type === "team";
  const isPlayedWith = axis.axis_type === "played_with";
  const isSeason = axis.axis_type === "season";
  const isNationality = axis.axis_type === "nationality";
  const countryCode = isNationality ? axis.country_code : null;
  const prefix =
    isNationality && !countryCode
      ? "\ud83c\udf0d "
      : isPlayedWith && !axis.image_url
        ? "\ud83e\udd1d "
        : isSeason
          ? "\ud83d\udcc5 "
          : "";
  const bgColor =
    isNationality
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : isPlayedWith
        ? "bg-amber-50 text-amber-800 border-amber-200"
        : isSeason
          ? "bg-violet-50 text-violet-800 border-violet-200"
          : "bg-slate-50 text-slate-700 border-slate-200";
  return (
    <div
      className={`px-2 py-3 text-[11px] sm:text-xs font-semibold text-center rounded-lg border ${bgColor} leading-tight flex flex-col items-center justify-center gap-1`}
    >
      {isTeam && axis.team_code && (
        <ClubLogo code={axis.team_code} size={28} />
      )}
      {isPlayedWith && axis.image_url && (
        <img
          src={axis.image_url}
          alt={axis.display_label}
          className="w-9 h-9 rounded-full object-cover object-top border border-amber-300"
          onError={(e) => { e.target.style.display = "none"; }}
        />
      )}
      {countryCode && (
        <img
          src={`https://flagcdn.com/w80/${countryCode.toLowerCase()}.png`}
          alt={axis.display_label}
          className="w-8 h-6 object-cover rounded-sm border border-emerald-200"
          onError={(e) => { e.target.style.display = "none"; }}
        />
      )}
      <span>
        {prefix}
        {axis.display_label || axis.team_name}
      </span>
    </div>
  );
}

const CONFETTI_PIECES = [
  { left: "6%", delay: "0s", duration: "2.7s", color: "#FF6600" },
  { left: "14%", delay: "0.25s", duration: "3.1s", color: "#2563EB" },
  { left: "22%", delay: "0.5s", duration: "2.5s", color: "#DC2626" },
  { left: "30%", delay: "0.1s", duration: "3.3s", color: "#059669" },
  { left: "38%", delay: "0.45s", duration: "2.8s", color: "#FF8533" },
  { left: "46%", delay: "0.2s", duration: "3.0s", color: "#D97706" },
  { left: "54%", delay: "0.55s", duration: "2.6s", color: "#2563EB" },
  { left: "62%", delay: "0.15s", duration: "3.2s", color: "#FF6600" },
  { left: "70%", delay: "0.4s", duration: "2.9s", color: "#DC2626" },
  { left: "78%", delay: "0.05s", duration: "3.4s", color: "#059669" },
  { left: "86%", delay: "0.5s", duration: "2.7s", color: "#FF8533" },
  { left: "94%", delay: "0.3s", duration: "3.1s", color: "#2563EB" },
];

// Lightweight celebratory confetti shown only to the winner. Purely decorative:
// pointer-events-none and aria-hidden so it never blocks the modal or assistive tech.
function VictoryConfetti() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {CONFETTI_PIECES.map((p, i) => (
        <span
          key={i}
          className="absolute -top-4 w-2 h-3 rounded-[1px]"
          style={{
            left: p.left,
            background: p.color,
            animation: `confetti-fall ${p.duration} linear ${p.delay} forwards`,
          }}
        />
      ))}
    </div>
  );
}

export default function GameBoard({ initialState, onNewGame, onHome, onlineInfo }) {
  const [game, setGame] = useState(initialState?.game || initialState);
  const [selectedCell, setSelectedCell] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const [roundTransition, setRoundTransition] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [resignConfirm, setResignConfirm] = useState(false);
  const [resultDismissed, setResultDismissed] = useState(false);

  const isOnline = onlineInfo?.isOnline;
  const myPlayer = onlineInfo?.playerNumber;
  const isSolo = game?.mode === "single_player";
  const realtimeUnavailableMessage = "Realtime connection unavailable. Reconnecting...";

  function handleRealtimeState(message) {
    const result = message.result;
    setGame(message.state);
    setError(null);
    if (result && message.completedRound && ["round_won", "round_drawn", "match_won", "board_complete", "draw_accepted"].includes(result)) {
      startRoundTransition(result, message.completedRound);
    } else if (result) {
      setLastResult(result);
      setSelectedCell(null);
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
    setLastResult(null);
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

  // Keep the dismissed-result flag tied to the match lifecycle. It only ever
  // becomes true after the user dismisses the victory modal on a finished game,
  // so resetting whenever the game is not finished guarantees a later finished
  // state always reveals the modal (and a polling refresh of a finished game,
  // which keeps status === "finished", never reopens a dismissed modal).
  useEffect(() => {
    if (game?.status !== "finished") setResultDismissed(false);
  }, [game?.status]);

  function startRoundTransition(result, completedRound) {
    if (completedRound) {
      setRoundTransition({ countdown: 3, completedRound, result });
    }
    setLastResult(result);
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
        setRoundTransition({ countdown: null, completedRound: res.completedRound, result: "gave_up" });
        setLastResult("gave_up");
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
      setResignConfirm(false);
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

  const resultMessages = {
    correct: isSolo ? "\u2705 Correct!" : "\u2705 Correct! Turn switches.",
    incorrect: isSolo ? "\u274c Incorrect." : "\u274c Incorrect. Turn switches.",
    round_won: "\ud83c\udfc6 Round won!",
    round_drawn: "\ud83e\udd1d Round drawn \u2014 new board!",
    match_won: "\ud83c\udf89 Match won!",
    board_complete: "\u2705 Board complete!",
    gave_up: "\ud83c\udff3\ufe0f Round given up.",
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

  // Subtitle shown in the victory modal. Reuse the perspective-aware forfeit
  // reason when we have it; otherwise (a normal final-round win, or a plain
  // GET refresh with no terminal reason) fall back to a generic line that is
  // still perspective-aware for online players.
  const finishedSubtitle =
    finishedReason ||
    (iWon
      ? "You won the match!"
      : isOnline && myPlayer != null
        ? "Better luck next time."
        : "Match complete \u2014 well played!");

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
        <div className="bg-elq-bg text-center py-1.5 text-xs text-elq-muted border-b border-elq-border">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Online
            {game.status === "active" && !isMyTurn && <span className="text-elq-orange ml-1">Waiting for opponent...</span>}
          </span>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center px-4 py-4 sm:py-6 max-w-2xl mx-auto w-full">
        {/* Scoreboard */}
        {isSolo ? (
          <div className="w-full bg-white rounded-2xl border border-elq-border shadow-sm p-4 sm:p-5 mb-4 animate-fade-in-up">
            <div className="text-center">
              <div className="text-sm font-semibold text-elq-player1">
                {game.player1_name}
              </div>
            </div>
          </div>
        ) : (
        <div className="w-full">
          <OnlineScoreboard
            ariaLabel="TicTacToe multiplayer scoreboard"
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
          <div className="w-full mb-4 animate-slide-down">
            <div
              className={`p-3 rounded-xl text-center text-sm font-medium ${
                ["round_won", "match_won", "board_complete"].includes(lastResult)
                  ? "bg-elq-orange/10 text-elq-orange border border-elq-orange/20"
                  : lastResult === "correct"
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                    : lastResult === "incorrect" || lastResult === "time_expired"
                      ? "bg-red-50 text-red-700 border border-red-200"
                      : "bg-amber-50 text-amber-700 border border-amber-200"
              }`}
            >
              {resultMessages[lastResult] || lastResult}
              {inTransition && roundTransition.countdown !== null && (
                <span className="ml-2 font-bold">
                  {isSolo ? `Next board in ${roundTransition.countdown}...` : `Next round in ${roundTransition.countdown}...`}
                </span>
              )}
            </div>
            {inTransition && roundTransition.countdown === null && (
              <div className="text-center mt-3">
                <button
                  onClick={() => { setRoundTransition(null); setLastResult(null); }}
                  className="px-6 py-2.5 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all"
                >
                  Start New Round
                </button>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="w-full mb-4 animate-slide-down">
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm text-center">
              {error}
            </div>
          </div>
        )}

        {/* Board */}
        <div className="w-full animate-fade-in-up" style={{ animationDelay: "100ms" }}>
          {/* Column headers */}
          <div
            className="grid gap-1.5 mb-1.5"
            style={{ gridTemplateColumns: "minmax(72px, 96px) repeat(3, 1fr)" }}
          >
            <div />
            {displayRound.columns.map((col, ci) => (
              <AxisLabel key={ci} axis={col} />
            ))}
          </div>

          {/* Rows */}
          {[0, 1, 2].map((ri) => (
            <div
              key={ri}
              className="grid gap-1.5 mb-1.5"
              style={{ gridTemplateColumns: "minmax(72px, 96px) repeat(3, 1fr)" }}
            >
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
                else if (isClickable) cellBg = "border-elq-border bg-white hover:border-elq-orange/40 hover:shadow-md hover:scale-[1.02] cursor-pointer active:scale-95";
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
                            src={cell.claimed_player_image_url}
                            alt={cell.claimed_player_name || ""}
                            className="w-6 h-6 rounded-full object-cover object-top border border-slate-200"
                            onError={(e) => { e.target.style.display = "none"; }}
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
                          <div className="mt-1 space-y-0.5">
                            {cell.sample_answers.map((name, i) => (
                              <div
                                key={i}
                                className="text-[9px] text-elq-muted italic leading-tight"
                              >
                                {name}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : showSamples ? (
                      <div className="space-y-0.5">
                        {cell.sample_answers.map((name, i) => (
                          <div
                            key={i}
                            className="text-[10px] text-elq-muted/70 italic leading-tight"
                          >
                            {name}
                          </div>
                        ))}
                      </div>
                    ) : isClickable ? (
                      <div className="text-elq-muted/30 text-xl">+</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Give Up button for solo mode */}
        {isSolo && game.status === "active" && !inTransition && (
          <div className="mt-6 text-center">
            <button
              onClick={handleGiveUp}
              disabled={loading}
              className="text-sm text-elq-muted hover:text-red-500 transition-colors underline underline-offset-2"
            >
              Give Up
            </button>
          </div>
        )}

        {/* Draw controls */}
        {!isSolo && game.status === "active" && !inTransition && (
          <div className="mt-6 text-center">
            {game.pending_draw ? (
              <div className="bg-white rounded-xl border border-elq-border p-4 animate-slide-down">
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
          </div>
        )}

        {/* Resign control for online games */}
        {isOnline && game.status === "active" && !inTransition && (
          <div className="mt-4 text-center">
            {resignConfirm ? (
              <div className="inline-flex flex-col items-center gap-2 bg-white rounded-xl border border-elq-border p-4 animate-slide-down">
                <p className="text-sm text-elq-text">Resign the match? Your opponent wins.</p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={handleResign}
                    disabled={loading}
                    className="px-5 py-2 bg-red-500 text-white font-medium rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50"
                  >
                    Resign
                  </button>
                  <button
                    type="button"
                    onClick={() => setResignConfirm(false)}
                    disabled={loading}
                    className="px-5 py-2 bg-white border border-elq-border text-elq-text font-medium rounded-lg hover:bg-elq-bg transition-colors disabled:opacity-50"
                  >
                    Keep playing
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setResignConfirm(true)}
                disabled={loading}
                className="text-sm text-elq-muted hover:text-red-500 transition-colors underline underline-offset-2"
              >
                Resign
              </button>
            )}
          </div>
        )}
      </div>

      {/* Player search modal */}
      {selectedCell && game.status === "active" && !inTransition && (
        <PlayerSearch
          rowTeamCode={selectedCell.row_team_code || null}
          colTeamCode={selectedCell.col_team_code || null}
          onSelect={handlePlayerSelect}
          onCancel={() => setSelectedCell(null)}
        />
      )}

      {/* Victory modal — revealed over the board so the result is seen at any
          scroll position. Dismissible via the scrim or the close button; the
          "View result" pill below reopens it so the final board stays inspectable. */}
      {!isSolo && game.status === "finished" && !inTransition && !resultDismissed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-overlay-in"
          style={{ background: "rgba(15, 25, 35, 0.62)", backdropFilter: "blur(4px)" }}
          onClick={() => setResultDismissed(true)}
          role="dialog"
          aria-modal="true"
          aria-label="Match result"
        >
          {iWon && <VictoryConfetti />}
          <div
            className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 sm:p-8 text-center animate-modal-in"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setResultDismissed(true)}
              aria-label="Close"
              className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-lg text-elq-muted hover:text-elq-text hover:bg-elq-bg transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>

            <div className="mx-auto mb-4 w-20 h-20 rounded-full bg-gradient-to-br from-elq-orange to-elq-orange-light flex items-center justify-center text-4xl shadow-lg animate-pulse-ring">
              {"\ud83c\udfc6"}
            </div>

            <h2 className="font-display text-4xl tracking-wide text-elq-dark mb-2">
              {game.winner_player === 1 ? game.player1_name : game.player2_name} WINS!
            </h2>

            <p className="text-sm text-elq-muted mb-6">{finishedSubtitle}</p>

            <div className="flex flex-col gap-2.5">
              <button
                onClick={onNewGame}
                className="w-full px-8 py-3 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all text-lg"
              >
                New Game
              </button>
              <button
                onClick={onHome}
                className="w-full px-8 py-2.5 bg-white border border-elq-border text-elq-text font-medium rounded-xl hover:bg-elq-bg active:scale-[0.98] transition-all"
              >
                Back to Home
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reopen the dismissed victory modal without scrolling. */}
      {!isSolo && game.status === "finished" && !inTransition && resultDismissed && (
        <button
          type="button"
          onClick={() => setResultDismissed(false)}
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 px-5 py-2.5 bg-elq-dark text-white text-sm font-semibold rounded-full shadow-lg hover:opacity-90 active:scale-95 transition-all flex items-center gap-2 animate-fade-in-up"
        >
          <span aria-hidden="true">{"\ud83c\udfc6"}</span> View result
        </button>
      )}
    </div>
  );
}
