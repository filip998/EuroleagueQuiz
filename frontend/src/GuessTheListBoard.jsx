import { useState, useEffect, useRef } from "react";
import { useListKeyboardNav } from "./useListKeyboardNav";
import { getGuessTheListGame, submitGuessTheList, offerEndRound, respondEndRound, connectGuessTheListRealtime, autocompleteGuessTheListPlayer, giveUpGuessTheListRound, resignGuessTheListGame } from "./api";
import { optimizeHeadshot, handleHeadshotError, HEADSHOT_WIDTHS } from "./imageUrl";
import { REALTIME_CLIENT_ACTIONS } from "./realtimeSchema";
import { useOnlineGameRealtime } from "./useOnlineGameRealtime";
import BoardHeaderNav from "./BoardHeaderNav";
import ClubLogo from "./ClubLogo";
import GameResult from "./GameResult";
import ResignControl from "./ResignControl";
import { winnerDisplayName } from "./winnerName";
import WaitingLobby from "./WaitingLobby";
import { buildInviteUrl } from "./inviteLink";

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

function normalizePlayerNumber(value) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return parsed === 1 || parsed === 2 ? parsed : null;
}

function detailRankLabel(round, slot) {
  if (round.category_type === "all_euroleague") {
    if (slot.rank === 1) return "1st";
    if (slot.rank === 2) return "2nd";
  }
  if (round.category_type === "award_winners") {
    return round.metric === "final_four_mvp" ? "F4" : "MVP";
  }
  return slot.rank != null ? `#${slot.rank}` : "?";
}

export default function GuessTheListBoard({ initialState, onNewGame, onHome, onlineInfo }) {
  const [game, setGame] = useState(initialState?.game || initialState);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(null);
  const [roundTransition, setRoundTransition] = useState(null);
  const [revealCountdown, setRevealCountdown] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [resigning, setResigning] = useState(false);
  const searchInputRef = useRef(null);

  const isSolo = game?.mode === "single_player";
  // A solo / local game must never be treated as online, even if `onlineInfo`
  // carries a stale seat recovered for a reused game id (see onlineRecovery.js).
  const isOnlineGame = game?.mode === "online_friend";
  const myPlayer = isOnlineGame && onlineInfo?.isOnline
    ? normalizePlayerNumber(onlineInfo.playerNumber)
    : null;
  const isOnline = isOnlineGame && myPlayer != null;
  const realtimeUnavailableMessage = "Realtime connection unavailable. Reconnecting...";
  const onlineSeatMissingMessage = "This online seat was not recovered. Reopen the original tab to respond.";

  function handleRealtimeState(message) {
    const result = message.result;
    setGame(message.state);
    setError(null);
    if (result && ["round_won","round_complete","match_won","board_complete"].includes(result)) {
      startRoundTransition(result, message.completedRound || message.state);
    } else if (result) {
      setLastResult(result);
    }
  }

  const realtime = useOnlineGameRealtime({
    enabled: isOnline,
    gameId: game?.id,
    gameStatus: game?.status,
    playerNumber: myPlayer,
    connect: connectGuessTheListRealtime,
    fetchState: getGuessTheListGame,
    onState: handleRealtimeState,
    onError: setError,
  });

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
  }, [timeLeft, game?.turn_seconds, game?.status, isOnline, isSolo]);

  useEffect(() => {
    if (!roundTransition) return;
    if (roundTransition.countdown === null) return; // paused (solo give-up)
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

  function startRoundTransition(result, completedRoundOrGame) {
    const completedRound = completedRoundOrGame?.slots ? completedRoundOrGame : completedRoundOrGame?.round;
    const unguessed = completedRound?.slots?.filter(s => s.guessed_by_player == null).length || 0;
    const revealTime = Math.max(3, unguessed * 2);
    setRevealCountdown(revealTime);
    setRoundTransition({ countdown: revealTime, completedRound, result });
    setLastResult(result);
    setSearchQuery(""); setSearchResults([]);
  }

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (searchQuery.length < 1) { setSearchResults([]); return; }
      setSearchLoading(true);
      try { const d = await autocompleteGuessTheListPlayer(searchQuery); setSearchResults(d.players || []); }
      catch { setSearchResults([]); } finally { setSearchLoading(false); }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const isMyTurn = !isOnlineGame || game?.current_player === myPlayer;
  const currentPlayerName = game?.current_player === 1 ? game?.player1_name : game?.player2_name;
  const inTransition = !!roundTransition;
  const isRevealing = revealCountdown !== null && revealCountdown > 0;
  const roundOver = round?.status === "completed" || round?.status === "given_up";

  async function handlePlayerSelect(player) {
    setSearchQuery(""); setSearchResults([]); setLoading(true); setError(null);
    try {
      if (isOnlineGame) {
        if (myPlayer == null) {
          setError(onlineSeatMissingMessage);
          return;
        }
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.GUESS, { player_id: player.player_id })) {
          setError(realtimeUnavailableMessage);
        }
        return;
      }

      const res = await submitGuessTheList(game.id, player.player_id);
      handleRealtimeState(res);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  async function handleGiveUp() {
    setLoading(true); setError(null);
    try {
      const res = await giveUpGuessTheListRound(game.id);
      setGame(res.state);
      setRoundTransition({ countdown: null, completedRound: res.completedRound, result: "given_up" });
      setLastResult("given_up");
      setSearchQuery(""); setSearchResults([]);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  async function handleResign() {
    setResigning(true); setError(null);
    try {
      if (myPlayer == null) {
        setError(onlineSeatMissingMessage);
        return;
      }
      const res = await resignGuessTheListGame(game.id, myPlayer);
      handleRealtimeState(res);
    } catch (e) { setError(e.message); } finally { setResigning(false); }
  }

  async function handleOfferEnd() {
    setLoading(true); setError(null);
    try {
      if (isOnlineGame) {
        if (myPlayer == null) {
          setError(onlineSeatMissingMessage);
          return;
        }
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.OFFER_END)) {
          const r = await offerEndRound(game.id, myPlayer);
          handleRealtimeState(r);
        }
        return;
      }
      const r = await offerEndRound(game.id); handleRealtimeState(r);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  async function handleRespondEnd(accept) {
    setLoading(true); setError(null);
    try {
      if (isOnlineGame) {
        if (myPlayer == null) {
          setError(onlineSeatMissingMessage);
          return;
        }
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.RESPOND_END, { accept })) {
          const r = await respondEndRound(game.id, accept, myPlayer);
          handleRealtimeState(r);
        }
        return;
      }

      const r = await respondEndRound(game.id, accept); handleRealtimeState(r);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  const { activeIndex, activeItemRef, handleKeyDown: handleNavKeyDown } =
    useListKeyboardNav(
      searchResults,
      handlePlayerSelect,
      searchFocused && searchQuery.length >= 1 && !searchLoading
    );

  function handleSearchKeyDown(e) {
    if (e.key === "Escape") { setSearchQuery(""); setSearchResults([]); searchInputRef.current?.blur(); return; }
    handleNavKeyDown(e);
  }

  const resultMessages = { correct: "\u2705 Correct!", incorrect: "\u274c Wrong player.", round_won: "\ud83c\udfc6 Round over!", round_complete: "\ud83c\udfc6 Round over!", match_won: "\ud83c\udf89 Match won!", board_complete: "\u2705 List complete!", end_offered: "\ud83e\udd1d End offered.", end_accepted: "\ud83e\udd1d Round ended!", end_declined: "Declined.", time_expired: "\u23f0 Time\u2019s up!", given_up: "\ud83c\udff3\ufe0f Gave up \u2014 full list revealed." };

  if (game?.status === "waiting_for_opponent") {
    return (
      <WaitingLobby
        joinCode={game.join_code}
        inviteUrl={buildInviteUrl(game.join_code, "/list")}
        onCancel={onNewGame}
      />
    );
  }

  if (!game || !round) {
    return (<div className="min-h-screen flex items-center justify-center"><svg className="w-8 h-8 text-elq-orange animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg></div>);
  }

  const displayRound = (inTransition && roundTransition.completedRound) ? roundTransition.completedRound : round;
  const usesRankedDetails = ["all_time", "single_season", "all_euroleague", "award_winners"].includes(displayRound.category_type);
  const usesScopeLabelHeader = usesRankedDetails || displayRound.category_type === "champions";
  const sortedSlots = usesRankedDetails
    ? [...displayRound.slots]
    : [...displayRound.slots].sort((a, b) => posRank(a.position) - posRank(b.position));
  const displayRoundOver = displayRound.status === "completed" || displayRound.status === "given_up";
  const canGuess = game.status === "active" && !inTransition && !isRevealing && !game.pending_end && isMyTurn && !roundOver;
  const pendingEnd = game.pending_end;
  const pendingOffererName = pendingEnd?.offered_by === 1 ? game.player1_name : game.player2_name;
  const pendingRecipientName = pendingEnd?.respond_to === 1 ? game.player1_name : game.player2_name;
  const canRespondToPendingEnd = Boolean(
    pendingEnd && (!isOnlineGame || myPlayer === pendingEnd.respond_to)
  );
  const isPendingEndSender = Boolean(
    pendingEnd && isOnlineGame && myPlayer === pendingEnd.offered_by
  );
  const isMissingOnlineSeat = isOnlineGame && myPlayer == null;
  const iWon = isOnline && myPlayer != null && game.winner_player === myPlayer;
  let finishedReason = null;
  if (lastResult === "resigned") {
    finishedReason = iWon ? "Your opponent resigned." : "You resigned.";
  } else if (lastResult === "opponent_left") {
    finishedReason = iWon ? "Your opponent left the game." : "You left the game.";
  }

  if (!isSolo && game.status === "finished" && !inTransition && !isRevealing) {
    const finishedWinnerName = winnerDisplayName(game);
    return (
      <GameResult
        title={finishedWinnerName ? `${finishedWinnerName} WINS!` : "No winner"}
        subtitle={
          finishedReason ||
          `${game.player1_name} ${game.player1_score} \u2013 ${game.player2_score} ${game.player2_name}`
        }
        onPlayAgain={onNewGame}
        onHome={onHome}
        celebrate={lastResult === "opponent_left" && iWon}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light flex-shrink-0" />
      <div className="bg-white border-b border-elq-border flex-shrink-0">
        <div className="max-w-5xl mx-auto px-3 py-2 flex items-center justify-between">
          <BoardHeaderNav onHome={onHome} />
          <span className="font-display text-base tracking-wide text-elq-dark">GUESS THE LIST</span>
          <span className="text-[11px] text-elq-muted">{isSolo ? "" : `Rd ${game.round_number} \u00b7 First to ${game.target_wins}`}</span>
        </div>
      </div>
      {isOnline && (<div className="bg-elq-bg text-center py-1 text-[11px] text-elq-muted border-b border-elq-border flex-shrink-0"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block mr-1.5" />You are <strong>{game[`player${myPlayer}_name`]}</strong>{!isMyTurn && <span className="text-elq-orange ml-1">&mdash; Opponent&apos;s turn</span>}</div>)}
      {isMissingOnlineSeat && (<div className="bg-amber-50 text-center py-1 text-[11px] text-amber-700 border-b border-amber-100 flex-shrink-0">{onlineSeatMissingMessage}</div>)}
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
          <div className="flex items-center gap-2 min-w-0">
            {usesScopeLabelHeader ? (
              <span className="font-display text-xl sm:text-2xl text-white tracking-wide truncate">{displayRound.scope_label}</span>
            ) : (
              <>
                <ClubLogo code={displayRound.team_code} size={28} className="flex-shrink-0" />
                <span className="font-display text-xl sm:text-2xl text-white tracking-wide truncate">{displayRound.team_name}</span>
                <span className="text-elq-orange font-semibold text-sm whitespace-nowrap">{displayRound.season_year}/{String(displayRound.season_year + 1).slice(2)}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-white/60 whitespace-nowrap">
            <span>{displayRound.guessed_count}/{displayRound.total_slots}</span>
            {!isSolo && (displayRound.player1_correct > 0 || displayRound.player2_correct > 0) && (<span><span className="text-blue-300">{displayRound.player1_correct}</span> &ndash; <span className="text-red-300">{displayRound.player2_correct}</span></span>)}
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
                  {!searchLoading && searchResults.length > 0 && searchResults.map((p, index) => (<button key={p.player_id} type="button" ref={index === activeIndex ? activeItemRef : undefined} aria-selected={index === activeIndex} onMouseDown={e => e.preventDefault()} onClick={() => handlePlayerSelect(p)} className={`w-full text-left px-4 py-2 text-sm hover:bg-elq-orange/5 hover:text-elq-orange transition-colors border-b border-elq-border/50 last:border-0 ${index === activeIndex ? "bg-elq-orange/5 text-elq-orange" : ""}`}>{p.full_name}</button>))}
                  {!searchLoading && searchQuery.length >= 1 && searchResults.length === 0 && <div className="px-4 py-3 text-sm text-elq-muted text-center">No players found</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {(lastResult || error) && (<div className="flex-shrink-0 px-3 pt-2 max-w-5xl mx-auto w-full">{lastResult && (<div className={`px-3 py-1.5 rounded-lg text-center text-xs font-medium animate-slide-down ${["round_won","match_won","round_complete","board_complete"].includes(lastResult) ? "bg-elq-orange/10 text-elq-orange" : lastResult === "correct" ? "bg-emerald-50 text-emerald-700" : lastResult === "incorrect" || lastResult === "time_expired" ? "bg-red-50 text-red-600" : lastResult === "given_up" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-700"}`}>{resultMessages[lastResult] || lastResult}{inTransition && roundTransition.countdown !== null && <span className="ml-2 font-bold">{isSolo ? `Next list in ${roundTransition.countdown}...` : `Next in ${roundTransition.countdown}...`}</span>}</div>)}{inTransition && roundTransition.countdown === null && (<div className="text-center mt-3"><button onClick={() => { setRoundTransition(null); setLastResult(null); }} className="px-6 py-2.5 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all">Start New Round</button></div>)}{error && <div className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs text-center mt-1">{error}</div>}</div>)}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-3 py-3">
          <div className="grid gap-1.5">
            {sortedSlots.map((slot) => {
              const guessed = slot.guessed_by_player != null;
              const revealed = !guessed && displayRoundOver && slot.player_name;
              const showPlayer = guessed || revealed;
              const p1 = slot.guessed_by_player === 1;
              const p2 = slot.guessed_by_player === 2;
              const bgClass = p1
                ? "bg-blue-50 border-elq-player1/30"
                : p2
                  ? "bg-red-50 border-elq-player2/30"
                  : revealed
                    ? "bg-amber-50/70 border-amber-200/60"
                    : "bg-white border-elq-border/50";
              return (
                <div
                  key={slot.id}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-xl border ${bgClass} transition-all duration-300`}
                >
                  {/* Player photo or mystery silhouette */}
                  <div className="flex-shrink-0 w-10 h-10 rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center">
                    {showPlayer && slot.image_url ? (
                      <img
                        src={optimizeHeadshot(slot.image_url, { width: HEADSHOT_WIDTHS.avatar })}
                        alt={slot.player_name}
                        className="w-full h-full object-cover object-top"
                        onError={(e) => handleHeadshotError(e, slot.image_url, (ev) => { ev.currentTarget.style.display = "none"; ev.currentTarget.nextSibling.style.display = "flex"; })}
                      />
                    ) : null}
                    <svg
                      className={`w-5 h-5 text-slate-300 ${showPlayer && slot.image_url ? "hidden" : ""}`}
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
                    </svg>
                  </div>

                  {/* Jersey number (roster) or leaderboard rank */}
                  <span className={`flex-shrink-0 w-8 text-center font-mono font-bold text-sm ${
                    p1 ? "text-elq-player1" : p2 ? "text-elq-player2" : "text-slate-400"
                  }`}>
                    {usesRankedDetails
                      ? (showPlayer ? detailRankLabel(displayRound, slot) : "?")
                      : (slot.jersey_number || "?")}
                  </span>

                  {/* Player name or mystery */}
                  <div className="flex-1 min-w-0">
                    {guessed ? (
                      <span className={`font-semibold text-sm truncate block ${p1 ? "text-elq-player1" : "text-elq-player2"}`}>
                        {slot.player_name}
                      </span>
                    ) : revealed ? (
                      <span className="text-sm text-amber-700 font-medium italic truncate block">
                        {slot.player_name}
                      </span>
                    ) : (
                      <span className="text-sm text-slate-300 font-medium">???</span>
                    )}
                  </div>

                  {/* Position badge */}
                  <span className={`flex-shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                    p1 ? "bg-elq-player1/10 text-elq-player1"
                    : p2 ? "bg-elq-player2/10 text-elq-player2"
                    : "bg-slate-100 text-slate-500"
                  }`}>
                    {posAbbr(slot.position)}
                  </span>

                  {/* Nationality flag + code */}
                  <div className="flex-shrink-0 flex items-center gap-1">
                    {slot.country_code ? (
                      <>
                        <img
                          src={`https://flagcdn.com/w40/${slot.country_code.toLowerCase()}.png`}
                          alt={slot.nationality}
                          title={slot.nationality}
                          className="w-5 h-3.5 object-cover rounded-[2px] border border-slate-200/80"
                          onError={(e) => { e.target.style.display = "none"; }}
                        />
                        <span className="text-[10px] text-slate-400 font-medium">{slot.country_code}</span>
                      </>
                    ) : (
                      <span className="text-[10px] text-slate-400">{slot.nationality ? slot.nationality.slice(0, 3).toUpperCase() : "\u2014"}</span>
                    )}
                  </div>

                  {/* Height (roster) or revealed stat value (leaderboard) */}
                  {usesRankedDetails ? (
                    <span className="flex-shrink-0 text-right text-xs font-bold tabular-nums text-elq-dark whitespace-nowrap min-w-[3.5rem]">
                      {showPlayer && slot.stat_value_label ? slot.stat_value_label : ""}
                    </span>
                  ) : (
                    <span className="flex-shrink-0 w-10 text-right text-[11px] text-slate-400 tabular-nums hidden sm:block">
                      {slot.height_cm ? `${slot.height_cm}` : "\u2014"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="bg-white border-t border-elq-border flex-shrink-0">
        <div className="max-w-5xl mx-auto px-3 py-2 flex items-center justify-center gap-4">
          {game.status === "active" && !inTransition && !isRevealing && !roundOver && (
            <>
              {pendingEnd ? (
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-elq-text">
                    {isPendingEndSender ? (
                      <>Waiting for <strong>{pendingRecipientName}</strong> to respond.</>
                    ) : (
                      <><strong>{pendingOffererName}</strong> wants to end.</>
                    )}
                  </span>
                  {canRespondToPendingEnd && (
                    <>
                      <button onClick={() => handleRespondEnd(true)} disabled={loading} className="px-3 py-1 bg-elq-success text-white text-xs font-semibold rounded-lg hover:opacity-90 disabled:opacity-50">Accept</button>
                      <button onClick={() => handleRespondEnd(false)} disabled={loading} className="px-3 py-1 bg-white border border-elq-border text-elq-text text-xs font-semibold rounded-lg hover:bg-elq-bg disabled:opacity-50">Decline</button>
                    </>
                  )}
                </div>
              ) : (<>
                {isMyTurn && game.mode !== "single_player" && (<button onClick={handleOfferEnd} disabled={loading} className="text-xs text-elq-muted hover:text-elq-text transition-colors">End Round</button>)}
                {game.mode === "single_player" && (<button onClick={handleGiveUp} disabled={loading} className="text-xs text-red-400 hover:text-red-600 transition-colors font-medium">Give Up</button>)}
              </>)}
            </>
          )}
          {isOnline && game.status === "active" && !inTransition && !isRevealing && (
            <ResignControl onResign={handleResign} disabled={resigning} />
          )}
          {isRevealing && !inTransition && (<span className="text-xs text-elq-muted">Reviewing list... <strong className="text-elq-orange">{revealCountdown}s</strong></span>)}
        </div>
      </div>
    </div>
  );
}
