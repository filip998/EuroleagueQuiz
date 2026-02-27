import { useState, useEffect, useRef } from "react";
import { getRosterGame, submitRosterGuess, offerEndRound, respondEndRound, connectRosterWebSocket, autocompleteRosterPlayer, giveUpRosterRound } from "./api";

const POSITION_ORDER = { "Guard": 0, "Guard-Forward": 1, "Forward": 2, "Forward-Center": 3, "Center": 4 };
function posRank(p) { return POSITION_ORDER[p] ?? 5; }
function posAbbr(p) {
  if (!p) return "\u2014";
  if (p.startsWith("Guard") && p !== "Guard-Forward") return "G";
  if (p === "Guard-Forward") return "G/F";
  if (p.startsWith("Forward") && p !== "Forward-Center") return "F";
  if (p === "Forward-Center") return "F/C";
  if (p.startsWith("Center")) return "C";
  return p.slice(0, 2).toUpperCase();
}

export default function RosterGuessBoard({ initialState, onNewGame, onHome, onlineInfo }) {
  const [game, setGame] = useState(initialState?.game || initialState);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const [roundTransition, setRoundTransition] = useState(null);
  const [revealCountdown, setRevealCountdown] = useState(null);
  const wsRef = useRef(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef(null);

  const isOnline = onlineInfo?.isOnline;
  const myPlayer = onlineInfo?.playerNumber;
  const isSolo = game?.mode === "single_player";

  useEffect(() => {
    if (!isOnline || !game?.id) return;
    let ws = null, reconnectTimeout = null, closed = false;
    function connect() {
      if (closed) return;
      ws = connectRosterWebSocket(game.id, myPlayer, (data) => {
        if (data.error) { setError(data.error); } else {
          const result = data.last_result;
          const gameData = { ...data }; delete gameData.last_result;
          setGame(gameData); setError(null);
          if (result && ["round_won","round_complete","match_won","board_complete"].includes(result)) startRoundTransition(result, gameData);
          else if (result) setLastResult(result);
        }
      }, () => { if (!closed) reconnectTimeout = setTimeout(connect, 2000); });
      wsRef.current = ws;
    }
    connect();
    return () => { closed = true; clearTimeout(reconnectTimeout); if (ws) ws.close(); wsRef.current = null; };
  }, [isOnline, game?.id, myPlayer]);

  useEffect(() => {
    if (!isOnline || !game?.id || game?.status === "waiting_for_opponent") return;
    const iv = setInterval(async () => { try { setGame(await getRosterGame(game.id)); } catch {} }, 10000);
    return () => clearInterval(iv);
  }, [isOnline, game?.id, game?.status]);

  useEffect(() => {
    if (!isOnline || game?.status !== "waiting_for_opponent") return;
    const iv = setInterval(async () => { try { const f = await getRosterGame(game.id); if (f.status === "active") setGame(f); } catch {} }, 2000);
    return () => clearInterval(iv);
  }, [isOnline, game?.id, game?.status]);

  const round = game?.round;

  useEffect(() => {
    if (!game?.turn_seconds || game.status !== "active") { setTimeLeft(null); return; }
    if (isOnline && game.turn_deadline_utc) {
      const calc = () => Math.max(0, Math.ceil((new Date(game.turn_deadline_utc).getTime() - Date.now()) / 1000));
      setTimeLeft(calc());
      const t = setInterval(() => setTimeLeft(calc()), 1000);
      return () => clearInterval(t);
    } else { setTimeLeft(game.turn_seconds); }
    setLastResult(null);
  }, [game?.turn_deadline_utc, game?.current_player, game?.round_number, game?.turn_seconds, game?.status, isOnline]);

  useEffect(() => {
    if (isOnline || !game?.turn_seconds || game.status !== "active" || timeLeft === null) return;
    if (timeLeft <= 0) { if (!isSolo) { setGame(p => ({ ...p, current_player: p.current_player === 1 ? 2 : 1 })); } setLastResult("time_expired"); return; }
    const t = setTimeout(() => setTimeLeft(v => v - 1), 1000);
    return () => clearTimeout(t);
  }, [timeLeft, game?.turn_seconds, game?.status, isOnline]);

  useEffect(() => {
    if (!roundTransition) return;
    if (roundTransition.countdown <= 0) { setRoundTransition(null); return; }
    const t = setTimeout(() => setRoundTransition(p => p ? { ...p, countdown: p.countdown - 1 } : null), 1000);
    return () => clearTimeout(t);
  }, [roundTransition]);

  // Reveal countdown after round ends or give up
  useEffect(() => {
    if (revealCountdown === null) return;
    if (revealCountdown <= 0) { setRevealCountdown(null); return; }
    const t = setTimeout(() => setRevealCountdown(v => v - 1), 1000);
    return () => clearTimeout(t);
  }, [revealCountdown]);

  function startRoundTransition(result, gameData) {
    const g = gameData || game;
    const unguessed = g?.round?.slots?.filter(s => s.guessed_by_player == null).length || 0;
    const revealTime = Math.max(3, unguessed * 2);
    setRevealCountdown(revealTime);
    setRoundTransition({ countdown: revealTime, result });
    setLastResult(result);
    setSearchQuery(""); setSearchResults([]);
  }

  function startGiveUpReveal(gameData) {
    const unguessed = gameData?.round?.slots?.filter(s => s.guessed_by_player == null).length || 0;
    const revealTime = Math.max(3, unguessed * 2);
    setRevealCountdown(revealTime);
    setLastResult("given_up");
    setSearchQuery(""); setSearchResults([]);
  }

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (searchQuery.length < 1) { setSearchResults([]); return; }
      setSearchLoading(true);
      try { const d = await autocompleteRosterPlayer(searchQuery); setSearchResults(d.players || []); }
      catch { setSearchResults([]); } finally { setSearchLoading(false); }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const isMyTurn = !isOnline || game?.current_player === myPlayer;
  const currentPlayerName = game?.current_player === 1 ? game?.player1_name : game?.player2_name;
  const inTransition = !!roundTransition;
  const isRevealing = revealCountdown !== null && revealCountdown > 0;
  const roundOver = round?.status === "completed" || round?.status === "given_up";

  async function handlePlayerSelect(player) {
    setSearchQuery(""); setSearchResults([]); setLoading(true); setError(null);
    try {
      if (isOnline && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: "guess", player_id: player.player_id }));
      } else {
        const res = await submitRosterGuess(game.id, player.player_id);
        setGame(res.game);
        if (["round_won","round_complete","match_won","board_complete"].includes(res.result)) startRoundTransition(res.result, res.game);
        else setLastResult(res.result);
      }
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  async function handleGiveUp() {
    setLoading(true); setError(null);
    try {
      const res = await giveUpRosterRound(game.id);
      setGame(res.game);
      startGiveUpReveal(res.game);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  async function handleOfferEnd() {
    setLoading(true); setError(null);
    try {
      if (isOnline && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ action: "offer_end" }));
      else { const r = await offerEndRound(game.id); setGame(r.game); setLastResult("end_offered"); }
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  async function handleRespondEnd(accept) {
    setLoading(true); setError(null);
    try {
      if (isOnline && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ action: "respond_end", accept }));
      else {
        const r = await respondEndRound(game.id, accept); setGame(r.game);
        if (accept && ["round_won","round_complete","match_won","board_complete"].includes(r.result)) startRoundTransition(r.result, r.game);
        else setLastResult(accept ? "end_accepted" : "end_declined");
      }
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  function handleSearchKeyDown(e) {
    if (e.key === "Escape") { setSearchQuery(""); setSearchResults([]); searchInputRef.current?.blur(); }
    if (e.key === "Enter" && searchResults.length === 1) handlePlayerSelect(searchResults[0]);
  }

  const resultMessages = { correct: "\u2705 Correct!", incorrect: "\u274c Wrong player.", round_won: "\ud83c\udfc6 Round over!", round_complete: "\ud83c\udfc6 Round over!", match_won: "\ud83c\udf89 Match won!", board_complete: "\u2705 Roster complete!", end_offered: "\ud83e\udd1d End offered.", end_accepted: "\ud83e\udd1d Round ended!", end_declined: "Declined.", time_expired: "\u23f0 Time\u2019s up!", given_up: "\ud83c\udff3\ufe0f Gave up \u2014 full roster revealed." };

  if (game?.status === "waiting_for_opponent") {
    return (<div className="min-h-screen flex flex-col"><div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" /><div className="flex-1 flex items-center justify-center p-4"><div className="text-center animate-fade-in-up"><div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-elq-orange/10 mb-6 animate-pulse-ring"><svg className="w-8 h-8 text-elq-orange animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg></div><h2 className="font-display text-4xl text-elq-dark mb-3">WAITING FOR OPPONENT</h2><p className="text-elq-muted mb-6">Share this code</p><div className="inline-block bg-elq-bg border-2 border-dashed border-elq-orange/30 rounded-2xl px-10 py-6 mb-6 select-all"><span className="font-mono text-5xl tracking-[0.3em] text-elq-dark font-bold">{game.join_code}</span></div><p className="text-sm text-elq-muted mb-8">Game starts when they join.</p><button onClick={onHome || onNewGame} className="text-sm text-elq-muted hover:text-elq-orange transition-colors underline underline-offset-2">Cancel</button></div></div></div>);
  }

  if (!game || !round) {
    return (<div className="min-h-screen flex items-center justify-center"><svg className="w-8 h-8 text-elq-orange animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg></div>);
  }

  const sortedSlots = [...round.slots].sort((a, b) => posRank(a.position) - posRank(b.position));
  const canGuess = game.status === "active" && !inTransition && !isRevealing && !game.pending_end && isMyTurn && !roundOver;

  if (!isSolo && game.status === "finished" && !inTransition && !isRevealing) {
    return (<div className="min-h-screen flex flex-col"><div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" /><div className="flex-1 flex items-center justify-center p-4"><div className="text-center animate-fade-in-up"><div className="text-5xl mb-3">{"\ud83c\udfc6"}</div><h2 className="font-display text-4xl text-elq-dark mb-2">{game.winner_player === 1 ? game.player1_name : game.player2_name} WINS!</h2><p className="text-elq-muted mb-6">{game.player1_name} {game.player1_score} &ndash; {game.player2_score} {game.player2_name}</p><div className="flex gap-3 justify-center"><button onClick={onNewGame} className="px-8 py-3 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all">Play Again</button>{onHome && <button onClick={onHome} className="px-8 py-3 bg-white border border-elq-border text-elq-text font-bold rounded-xl hover:bg-elq-bg transition-all">Home</button>}</div></div></div></div>);
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light flex-shrink-0" />
      <div className="bg-white border-b border-elq-border flex-shrink-0">
        <div className="max-w-5xl mx-auto px-3 py-2 flex items-center justify-between">
          <button onClick={onHome || onNewGame} className="text-xs text-elq-muted hover:text-elq-text transition-colors flex items-center gap-1"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" /></svg>Home</button>
          <span className="font-display text-base tracking-wide text-elq-dark">ROSTER GUESS</span>
          <span className="text-[11px] text-elq-muted">{isSolo ? "" : `Rd ${game.round_number} \u00b7 First to ${game.target_wins}`}</span>
        </div>
      </div>
      {isOnline && (<div className="bg-elq-bg text-center py-1 text-[11px] text-elq-muted border-b border-elq-border flex-shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block mr-1.5" />You are <strong>{game[`player${myPlayer}_name`]}</strong>{!isMyTurn && <span className="text-elq-orange ml-1">&mdash; Opponent&apos;s turn</span>}</div>)}
      {isSolo ? (
      <div className="bg-white border-b border-elq-border flex-shrink-0">
        <div className="max-w-5xl mx-auto px-3 py-2 text-center">
          <span className="font-semibold text-sm text-elq-player1">{game.player1_name}</span>
        </div>
      </div>
      ) : (
      <div className="bg-white border-b border-elq-border flex-shrink-0">
        <div className="max-w-5xl mx-auto px-3 py-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0"><span className={`font-semibold text-sm truncate ${game.current_player === 1 && game.status === "active" ? "text-elq-player1" : "text-elq-muted"}`}>{game.player1_name}</span><span className="text-xl font-bold text-elq-dark">{game.player1_score}</span>{game.current_player === 1 && game.status === "active" && <span className="w-1.5 h-1.5 rounded-full bg-elq-player1 animate-pulse flex-shrink-0" />}</div>
          <div className="text-center flex-shrink-0 px-3">{game.turn_seconds && game.status === "active" && timeLeft !== null ? (<span className={`text-lg font-bold font-mono tabular-nums ${timeLeft <= 5 ? "animate-timer-critical" : "text-elq-dark"}`}>{timeLeft}<span className="text-[10px] text-elq-muted font-normal">s</span></span>) : (<span className="text-xs text-elq-muted">{game.status === "active" ? `${currentPlayerName}\u2019s turn` : ""}</span>)}</div>
          <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">{game.current_player === 2 && game.status === "active" && <span className="w-1.5 h-1.5 rounded-full bg-elq-player2 animate-pulse flex-shrink-0" />}<span className="text-xl font-bold text-elq-dark">{game.player2_score}</span><span className={`font-semibold text-sm truncate ${game.current_player === 2 && game.status === "active" ? "text-elq-player2" : "text-elq-muted"}`}>{game.player2_name}</span></div>
        </div>
      </div>
      )}
      <div className="bg-elq-dark flex-shrink-0">
        <div className="max-w-5xl mx-auto px-3 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0"><span className="font-display text-xl sm:text-2xl text-white tracking-wide truncate">{round.team_name}</span><span className="text-elq-orange font-semibold text-sm whitespace-nowrap">{round.season_year}/{String(round.season_year + 1).slice(2)}</span></div>
          <div className="flex items-center gap-3 text-[11px] text-white/60 whitespace-nowrap">
            <span>{round.guessed_count}/{round.total_slots}</span>
            {!isSolo && (round.player1_correct > 0 || round.player2_correct > 0) && (<span><span className="text-blue-300">{round.player1_correct}</span> &ndash; <span className="text-red-300">{round.player2_correct}</span></span>)}
            {isRevealing && <span className="text-elq-orange font-semibold">{revealCountdown}s</span>}
          </div>
        </div>
      </div>
      {canGuess && (
        <div className="bg-white border-b border-elq-border flex-shrink-0 relative z-30">
          <div className="max-w-5xl mx-auto px-3 py-2">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-elq-muted pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
              <input ref={searchInputRef} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={handleSearchKeyDown} onFocus={() => setSearchFocused(true)} onBlur={() => setTimeout(() => setSearchFocused(false), 200)} placeholder="Type a player name to guess..." className="w-full pl-10 pr-4 py-2 rounded-lg border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:bg-white focus:ring-0 focus:outline-none transition-colors" />
              {searchFocused && searchQuery.length >= 1 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl border border-elq-border shadow-xl max-h-56 overflow-y-auto z-40">
                  {searchLoading && <div className="px-4 py-3 text-sm text-elq-muted text-center">Searching...</div>}
                  {!searchLoading && searchResults.length > 0 && searchResults.map(p => (<button key={p.player_id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => handlePlayerSelect(p)} className="w-full text-left px-4 py-2 text-sm hover:bg-elq-orange/5 hover:text-elq-orange transition-colors border-b border-elq-border/50 last:border-0">{p.full_name}</button>))}
                  {!searchLoading && searchQuery.length >= 1 && searchResults.length === 0 && <div className="px-4 py-3 text-sm text-elq-muted text-center">No players found</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {(lastResult || error) && (<div className="flex-shrink-0 px-3 pt-2 max-w-5xl mx-auto w-full">{lastResult && (<div className={`px-3 py-1.5 rounded-lg text-center text-xs font-medium animate-slide-down ${["round_won","match_won","round_complete","board_complete"].includes(lastResult) ? "bg-elq-orange/10 text-elq-orange" : lastResult === "correct" ? "bg-emerald-50 text-emerald-700" : lastResult === "incorrect" || lastResult === "time_expired" ? "bg-red-50 text-red-600" : lastResult === "given_up" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-700"}`}>{resultMessages[lastResult] || lastResult}{inTransition && <span className="ml-2 font-bold">{isSolo ? `Next roster in ${roundTransition.countdown}...` : `Next in ${roundTransition.countdown}...`}</span>}</div>)}{error && <div className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs text-center mt-1">{error}</div>}</div>)}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-3 py-2">
          <table className="w-full text-sm border-collapse">
            <thead><tr className="border-b-2 border-elq-dark/20 bg-slate-50"><th className="text-center py-2.5 px-2 font-bold text-xs uppercase tracking-wider text-elq-dark">Player</th><th className="text-center py-2.5 px-2 w-10 font-bold text-xs uppercase tracking-wider text-elq-dark">#</th><th className="text-center py-2.5 px-2 w-12 font-bold text-xs uppercase tracking-wider text-elq-dark">Pos</th><th className="text-center py-2.5 px-2 font-bold text-xs uppercase tracking-wider text-elq-dark">Nationality</th><th className="text-center py-2.5 px-2 w-20 font-bold text-xs uppercase tracking-wider text-elq-dark hidden sm:table-cell">Ht (cm)</th></tr></thead>
            <tbody>
              {sortedSlots.map((slot, i) => {
                const guessed = slot.guessed_by_player != null;
                const revealed = !guessed && roundOver && slot.player_name;
                const p1 = slot.guessed_by_player === 1;
                const p2 = slot.guessed_by_player === 2;
                return (
                  <tr key={slot.id} className={`border-b border-elq-border/40 transition-colors ${p1 ? "bg-blue-50/70" : p2 ? "bg-red-50/70" : revealed ? "bg-amber-50/50" : i % 2 === 0 ? "bg-white" : "bg-slate-50/40"}`}>
                    <td className="py-1.5 px-2 text-center">{guessed ? (<span className={`font-semibold text-sm ${p1 ? "text-elq-player1" : "text-elq-player2"}`}>{slot.player_name}</span>) : revealed ? (<span className="text-sm text-amber-700 font-medium italic">{slot.player_name}</span>) : (<span className="text-slate-300 text-sm">???</span>)}</td>
                    <td className="py-1.5 px-2 text-center"><span className={`inline-flex items-center justify-center w-7 h-7 rounded-md text-[11px] font-bold font-mono ${p1 ? "bg-elq-player1/10 text-elq-player1" : p2 ? "bg-elq-player2/10 text-elq-player2" : "bg-slate-100 text-slate-500"}`}>{slot.jersey_number || "?"}</span></td>
                    <td className="py-1.5 px-2 text-center text-xs text-elq-muted font-medium">{posAbbr(slot.position)}</td>
                    <td className="py-1.5 px-2 text-center text-xs text-elq-muted">{slot.nationality || "\u2014"}</td>
                    <td className="py-1.5 px-2 text-center text-xs text-elq-muted hidden sm:table-cell">{slot.height_cm || "\u2014"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="bg-white border-t border-elq-border flex-shrink-0">
        <div className="max-w-5xl mx-auto px-3 py-2 flex items-center justify-center gap-4">
          {game.status === "active" && !inTransition && !isRevealing && !roundOver && (
            <>
              {game.pending_end ? (<div className="flex items-center gap-3 text-sm"><span className="text-elq-text"><strong>{game.pending_end.offered_by === 1 ? game.player1_name : game.player2_name}</strong> wants to end.</span>{(!isOnline || myPlayer === game.pending_end.respond_to) && (<><button onClick={() => handleRespondEnd(true)} disabled={loading} className="px-3 py-1 bg-elq-success text-white text-xs font-semibold rounded-lg hover:opacity-90 disabled:opacity-50">Accept</button><button onClick={() => handleRespondEnd(false)} disabled={loading} className="px-3 py-1 bg-white border border-elq-border text-elq-text text-xs font-semibold rounded-lg hover:bg-elq-bg disabled:opacity-50">Decline</button></>)}</div>) : (<>
                {isMyTurn && game.mode !== "single_player" && (<button onClick={handleOfferEnd} disabled={loading} className="text-xs text-elq-muted hover:text-elq-text transition-colors">End Round</button>)}
                {game.mode === "single_player" && (<button onClick={handleGiveUp} disabled={loading} className="text-xs text-red-400 hover:text-red-600 transition-colors font-medium">Give Up</button>)}
              </>)}
            </>
          )}
          {isRevealing && !inTransition && (<span className="text-xs text-elq-muted">Reviewing roster... <strong className="text-elq-orange">{revealCountdown}s</strong></span>)}
        </div>
      </div>
    </div>
  );
}
