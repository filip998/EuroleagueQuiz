import { useState, useEffect, useCallback, useRef } from "react";
import { getRosterGame, submitRosterGuess, offerEndRound, respondEndRound, connectRosterWebSocket } from "./api";
import PlayerSearch from "./PlayerSearch";

export default function RosterGuessBoard({ initialState, onNewGame, onHome, onlineInfo }) {
  const [game, setGame] = useState(initialState?.game || initialState);
  const [showSearch, setShowSearch] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const [roundTransition, setRoundTransition] = useState(null);
  const wsRef = useRef(null);

  const isOnline = onlineInfo?.isOnline;
  const myPlayer = onlineInfo?.playerNumber;

  // WebSocket connection
  useEffect(() => {
    if (!isOnline || !game?.id) return;
    let ws = null;
    let reconnectTimeout = null;
    let closed = false;

    function connect() {
      if (closed) return;
      ws = connectRosterWebSocket(game.id, myPlayer, (data) => {
        if (data.error) {
          setError(data.error);
        } else {
          const result = data.last_result;
          const gameData = { ...data };
          delete gameData.last_result;
          setGame(gameData);
          setError(null);
          if (result && ["round_won", "round_complete", "match_won"].includes(result)) {
            startRoundTransition(result);
          } else if (result) {
            setLastResult(result);
          }
        }
      }, () => {
        if (!closed) reconnectTimeout = setTimeout(connect, 2000);
      });
      wsRef.current = ws;
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimeout);
      if (ws) ws.close();
      wsRef.current = null;
    };
  }, [isOnline, game?.id, myPlayer]);

  // Periodic sync for online
  useEffect(() => {
    if (!isOnline || !game?.id || game?.status === "waiting_for_opponent") return;
    const interval = setInterval(async () => {
      try { const fresh = await getRosterGame(game.id); setGame(fresh); } catch {}
    }, 10000);
    return () => clearInterval(interval);
  }, [isOnline, game?.id, game?.status]);

  // Poll for opponent
  useEffect(() => {
    if (!isOnline || game?.status !== "waiting_for_opponent") return;
    const interval = setInterval(async () => {
      try {
        const fresh = await getRosterGame(game.id);
        if (fresh.status === "active") setGame(fresh);
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [isOnline, game?.id, game?.status]);

  const round = game?.round;

  // Timer
  useEffect(() => {
    if (!game?.turn_seconds || game.status !== "active") { setTimeLeft(null); return; }
    if (isOnline && game.turn_deadline_utc) {
      const computeRemaining = () => {
        const deadline = new Date(game.turn_deadline_utc).getTime();
        return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      };
      setTimeLeft(computeRemaining());
      const timer = setInterval(() => {
        const remaining = computeRemaining();
        setTimeLeft(remaining);
      }, 1000);
      return () => clearInterval(timer);
    } else {
      setTimeLeft(game.turn_seconds);
    }
    setLastResult(null);
  }, [game?.turn_deadline_utc, game?.current_player, game?.round_number, game?.turn_seconds, game?.status, isOnline]);

  // Local countdown
  useEffect(() => {
    if (isOnline) return;
    if (!game?.turn_seconds || game.status !== "active" || timeLeft === null) return;
    if (timeLeft <= 0) {
      setGame((prev) => ({ ...prev, current_player: prev.current_player === 1 ? 2 : 1 }));
      setLastResult("time_expired");
      return;
    }
    const timer = setTimeout(() => setTimeLeft((t) => t - 1), 1000);
    return () => clearTimeout(timer);
  }, [timeLeft, game?.turn_seconds, game?.status, isOnline]);

  // Round transition
  useEffect(() => {
    if (!roundTransition) return;
    if (roundTransition.countdown <= 0) { setRoundTransition(null); return; }
    const timer = setTimeout(() => {
      setRoundTransition((prev) => prev ? { ...prev, countdown: prev.countdown - 1 } : null);
    }, 1000);
    return () => clearTimeout(timer);
  }, [roundTransition]);

  function startRoundTransition(result) {
    setRoundTransition({ countdown: 3, result });
    setLastResult(result);
    setShowSearch(false);
  }

  const isMyTurn = !isOnline || game?.current_player === myPlayer;
  const currentPlayerName = game?.current_player === 1 ? game?.player1_name : game?.player2_name;
  const inTransition = !!roundTransition;

  async function handlePlayerSelect(player) {
    setShowSearch(false);
    setLoading(true);
    setError(null);
    try {
      if (isOnline && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: "guess", player_id: player.player_id }));
      } else {
        const res = await submitRosterGuess(game.id, player.player_id);
        setGame(res.game);
        if (["round_won", "round_complete", "match_won"].includes(res.result)) {
          startRoundTransition(res.result);
        } else {
          setLastResult(res.result);
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOfferEnd() {
    setLoading(true);
    setError(null);
    try {
      if (isOnline && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: "offer_end" }));
      } else {
        const res = await offerEndRound(game.id);
        setGame(res.game);
        setLastResult("end_offered");
      }
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function handleRespondEnd(accept) {
    setLoading(true);
    setError(null);
    try {
      if (isOnline && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: "respond_end", accept }));
      } else {
        const res = await respondEndRound(game.id, accept);
        setGame(res.game);
        if (accept && ["round_won", "round_complete", "match_won"].includes(res.result)) {
          startRoundTransition(res.result);
        } else {
          setLastResult(accept ? "end_accepted" : "end_declined");
        }
      }
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  const resultMessages = {
    correct: "\u2705 Correct!",
    incorrect: "\u274c Incorrect.",
    round_won: "\ud83c\udfc6 Round complete!",
    round_complete: "\ud83c\udfc6 Round complete!",
    match_won: "\ud83c\udf89 Match won!",
    end_offered: "\ud83e\udd1d End offered.",
    end_accepted: "\ud83e\udd1d Round ended!",
    end_declined: "End declined \u2014 game continues.",
    time_expired: "\u23f0 Time\u2019s up!",
  };

  // Waiting for opponent
  if (game?.status === "waiting_for_opponent") {
    return (
      <div className="min-h-screen flex flex-col">
        <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center animate-fade-in-up">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-elq-orange/10 mb-6 animate-pulse-ring">
              <svg className="w-8 h-8 text-elq-orange animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            </div>
            <h2 className="font-display text-4xl text-elq-dark mb-3">WAITING FOR OPPONENT</h2>
            <p className="text-elq-muted mb-6">Share this code with your friend</p>
            <div className="inline-block bg-elq-bg border-2 border-dashed border-elq-orange/30 rounded-2xl px-10 py-6 mb-6 select-all">
              <span className="font-mono text-5xl tracking-[0.3em] text-elq-dark font-bold">{game.join_code}</span>
            </div>
            <p className="text-sm text-elq-muted mb-8">The game will start automatically when they join.</p>
            <button onClick={onHome || onNewGame} className="text-sm text-elq-muted hover:text-elq-orange transition-colors underline underline-offset-2">Cancel</button>
          </div>
        </div>
      </div>
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

  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      {/* Header */}
      <div className="bg-white border-b border-elq-border">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <button onClick={onHome || onNewGame} className="text-sm text-elq-muted hover:text-elq-text transition-colors flex items-center gap-1.5">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
            </svg>
            Home
          </button>
          <span className="font-display text-lg tracking-wide text-elq-dark">ROSTER GUESS</span>
          <span className="text-xs text-elq-muted">Round {game.round_number} &middot; First to {game.target_wins}</span>
        </div>
      </div>

      {/* Online indicator */}
      {isOnline && (
        <div className="bg-elq-bg text-center py-1.5 text-xs text-elq-muted border-b border-elq-border">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Online &mdash; You are <strong>{game[`player${myPlayer}_name`]}</strong>
            {!isMyTurn && <span className="text-elq-orange ml-1">Waiting for opponent...</span>}
          </span>
        </div>
      )}

      <div className="flex-1 flex flex-col items-center px-4 py-4 sm:py-6 max-w-3xl mx-auto w-full">
        {/* Scoreboard */}
        <div className="w-full bg-white rounded-2xl border border-elq-border shadow-sm p-4 sm:p-5 mb-4 animate-fade-in-up">
          <div className="flex items-center justify-between">
            <div className="text-center flex-1">
              <div className={`text-sm font-semibold transition-colors ${game.current_player === 1 && game.status === "active" ? "text-elq-player1" : "text-elq-muted"}`}>{game.player1_name}</div>
              <div className="text-3xl sm:text-4xl font-bold text-elq-dark mt-1">{game.player1_score}</div>
              {game.current_player === 1 && game.status === "active" && <div className="w-2 h-2 rounded-full bg-elq-player1 mx-auto mt-2 animate-pulse" />}
            </div>
            <div className="text-center px-4 flex-shrink-0">
              {game.turn_seconds && game.status === "active" && timeLeft !== null && (
                <div className={`text-3xl sm:text-4xl font-bold font-mono tabular-nums ${timeLeft <= 5 ? "animate-timer-critical" : "text-elq-dark"}`}>
                  {timeLeft}<span className="text-sm text-elq-muted font-normal ml-0.5">s</span>
                </div>
              )}
              <div className="text-xs text-elq-muted mt-1">
                {game.status === "finished"
                  ? `\ud83c\udf89 ${game.winner_player === 1 ? game.player1_name : game.player2_name} wins!`
                  : `${currentPlayerName}'s turn`}
              </div>
            </div>
            <div className="text-center flex-1">
              <div className={`text-sm font-semibold transition-colors ${game.current_player === 2 && game.status === "active" ? "text-elq-player2" : "text-elq-muted"}`}>{game.player2_name}</div>
              <div className="text-3xl sm:text-4xl font-bold text-elq-dark mt-1">{game.player2_score}</div>
              {game.current_player === 2 && game.status === "active" && <div className="w-2 h-2 rounded-full bg-elq-player2 mx-auto mt-2 animate-pulse" />}
            </div>
          </div>
        </div>

        {/* Team + Season header */}
        <div className="w-full bg-white rounded-xl border border-elq-border p-3 mb-4 text-center animate-fade-in-up" style={{ animationDelay: "50ms" }}>
          <div className="font-display text-2xl sm:text-3xl text-elq-dark tracking-wide">{round.team_name}</div>
          <div className="text-sm text-elq-orange font-semibold mt-1">{round.season_year}/{String(round.season_year + 1).slice(2)} Season</div>
          <div className="text-xs text-elq-muted mt-1">
            {round.guessed_count}/{round.total_slots} guessed
            {round.player1_correct > 0 || round.player2_correct > 0 ? ` \u2014 P1: ${round.player1_correct}, P2: ${round.player2_correct}` : ""}
          </div>
        </div>

        {/* Result banner */}
        {lastResult && (
          <div className="w-full mb-4 animate-slide-down">
            <div className={`p-3 rounded-xl text-center text-sm font-medium ${
              ["round_won", "match_won", "round_complete"].includes(lastResult)
                ? "bg-elq-orange/10 text-elq-orange border border-elq-orange/20"
                : lastResult === "correct" ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : lastResult === "incorrect" || lastResult === "time_expired" ? "bg-red-50 text-red-700 border border-red-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}>
              {resultMessages[lastResult] || lastResult}
              {inTransition && <span className="ml-2 font-bold">Next round in {roundTransition.countdown}...</span>}
            </div>
          </div>
        )}

        {error && (
          <div className="w-full mb-4 animate-slide-down">
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm text-center">{error}</div>
          </div>
        )}

        {/* Roster grid */}
        <div className="w-full space-y-2 animate-fade-in-up" style={{ animationDelay: "100ms" }}>
          {round.slots.map((slot) => {
            const guessed = slot.guessed_by_player != null;
            const colorClass = slot.guessed_by_player === 1
              ? "border-elq-player1/30 bg-elq-player1-bg"
              : slot.guessed_by_player === 2
                ? "border-elq-player2/30 bg-elq-player2-bg"
                : "border-elq-border bg-white";

            return (
              <div key={slot.id} className={`rounded-xl border-2 p-3 sm:p-4 transition-all ${colorClass}`}>
                <div className="flex items-center gap-3 sm:gap-4">
                  {/* Jersey number */}
                  <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg bg-elq-bg border border-elq-border flex items-center justify-center font-bold text-elq-dark text-sm sm:text-base flex-shrink-0">
                    {slot.jersey_number || "?"}
                  </div>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    {guessed ? (
                      <div className="animate-cell-claim">
                        <div className={`font-bold text-sm sm:text-base ${slot.guessed_by_player === 1 ? "text-elq-player1" : "text-elq-player2"}`}>
                          {slot.player_name}
                        </div>
                        <div className="text-[11px] text-elq-muted mt-0.5">
                          {[slot.position, slot.nationality, slot.height_cm ? `${slot.height_cm}cm` : null].filter(Boolean).join(" \u00b7 ")}
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {slot.position && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-xs font-medium">{slot.position}</span>
                        )}
                        {slot.nationality && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-xs font-medium">{slot.nationality}</span>
                        )}
                        {slot.height_cm && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-xs font-medium">{slot.height_cm}cm</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Guess button */}
        {game.status === "active" && !inTransition && !game.pending_end && isMyTurn && (
          <div className="mt-6 w-full">
            <button
              onClick={() => { setShowSearch(true); setLastResult(null); }}
              disabled={loading}
              className="w-full py-3.5 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 text-lg tracking-wide"
            >
              Guess a Player
            </button>
          </div>
        )}

        {/* End controls */}
        {game.status === "active" && !inTransition && (
          <div className="mt-4 text-center">
            {game.pending_end ? (
              <div className="bg-white rounded-xl border border-elq-border p-4 animate-slide-down">
                <p className="text-sm text-elq-text mb-3">
                  <strong>{game.pending_end.offered_by === 1 ? game.player1_name : game.player2_name}</strong> offers to end the round.
                  <strong> {game.pending_end.respond_to === 1 ? game.player1_name : game.player2_name}</strong>, do you accept?
                </p>
                {(!isOnline || myPlayer === game.pending_end.respond_to) && (
                  <div className="flex gap-3 justify-center">
                    <button onClick={() => handleRespondEnd(true)} disabled={loading} className="px-5 py-2 bg-elq-success text-white font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">Accept</button>
                    <button onClick={() => handleRespondEnd(false)} disabled={loading} className="px-5 py-2 bg-white border border-elq-border text-elq-text font-medium rounded-lg hover:bg-elq-bg transition-colors disabled:opacity-50">Decline</button>
                  </div>
                )}
              </div>
            ) : (
              isMyTurn && game.mode !== "single_player" && (
                <button onClick={handleOfferEnd} disabled={loading} className="text-sm text-elq-muted hover:text-elq-text transition-colors underline underline-offset-2">
                  Offer to End Round
                </button>
              )
            )}
          </div>
        )}

        {/* Match finished */}
        {game.status === "finished" && !inTransition && (
          <div className="mt-8 text-center animate-fade-in-up">
            <div className="text-4xl mb-2">{"\ud83c\udfc6"}</div>
            <h2 className="font-display text-3xl text-elq-dark mb-4">
              {game.winner_player === 1 ? game.player1_name : game.player2_name} WINS!
            </h2>
            <div className="flex gap-3 justify-center">
              <button onClick={onNewGame} className="px-8 py-3 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all text-lg">
                Play Again
              </button>
              {onHome && (
                <button onClick={onHome} className="px-8 py-3 bg-white border border-elq-border text-elq-text font-bold rounded-xl hover:bg-elq-bg transition-all text-lg">
                  Home
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Player search modal */}
      {showSearch && !inTransition && (
        <PlayerSearch
          rowTeamCode={round.team_code}
          colTeamCode={null}
          onSelect={handlePlayerSelect}
          onCancel={() => setShowSearch(false)}
          rosterMode
        />
      )}
    </div>
  );
}
