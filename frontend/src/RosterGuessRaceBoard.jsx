import { useEffect, useRef, useState } from "react";
import {
  autocompleteRosterPlayer,
  cancelRosterRaceQuickMatch,
  connectRosterGuessRealtime,
  getRosterGame,
  submitRosterGuess,
} from "./api";
import { REALTIME_CLIENT_ACTIONS } from "./realtimeSchema";
import { useOnlineGameRealtime } from "./useOnlineGameRealtime";
import WaitingLobby from "./WaitingLobby";
import QuickMatchSearchingLobby from "./QuickMatchSearchingLobby";
import { buildInviteUrl } from "./inviteLink";
import { clearOnlineInfo } from "./onlineRecovery";
import { forgetQuickMatchSeat } from "./quickMatchSeats";
import {
  rosterRacePresetLabel,
  rosterRaceSeatKey,
  useRosterRaceQuickMatchPools,
} from "./rosterRaceQuickMatch";
import ClubLogo from "./ClubLogo";
import BoardHeaderNav from "./BoardHeaderNav";

const POSITION_ORDER = { Guard: 0, "Guard-Forward": 1, Forward: 2, "Forward-Center": 3, Center: 4 };

function posRank(position) {
  return POSITION_ORDER[position] ?? 5;
}

export default function RosterGuessRaceBoard({ initialState, onlineInfo, onNewGame, onHome }) {
  const [game, setGame] = useState(initialState);
  const [message, setMessage] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [lastRevealedRoundNumber, setLastRevealedRoundNumber] = useState(
    initialState?.latest_completed_round?.round_number ?? null
  );
  const [completedRound, setCompletedRound] = useState(initialState?.latest_completed_round ?? null);
  const [cancelling, setCancelling] = useState(false);
  const searchInputRef = useRef(null);

  const playerNumber = onlineInfo?.playerNumber ?? null;
  const isOnline = Boolean(onlineInfo);
  const currentRound = game?.round;
  const latestCompletedRound = game?.latest_completed_round;
  const revealStartsAt = latestCompletedRound?.next_round_starts_at || null;
  const revealRemaining = secondsUntil(revealStartsAt, nowMs);
  const roundLocked = revealRemaining > 0;
  const timerRemaining = secondsUntil(game?.race_round_deadline_utc, nowMs);
  const displayRound = roundLocked && latestCompletedRound ? latestCompletedRound : currentRound;
  const canGuess = Boolean(
    isOnline
    && playerNumber
    && game?.status === "active"
    && currentRound?.status === "active"
    && !roundLocked
  );

  useEffect(() => {
    const needsTick = Boolean(revealStartsAt || game?.race_round_deadline_utc);
    if (!needsTick) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [revealStartsAt, game?.race_round_deadline_utc]);

  useEffect(() => {
    if (!latestCompletedRound?.round_number) return;
    if (latestCompletedRound.round_number === lastRevealedRoundNumber) return;
    setCompletedRound(latestCompletedRound);
    setLastRevealedRoundNumber(latestCompletedRound.round_number);
  }, [latestCompletedRound, lastRevealedRoundNumber]);

  useEffect(() => {
    if (!completedRound || roundLocked) return undefined;
    const timer = setTimeout(() => setCompletedRound(null), 3000);
    return () => clearTimeout(timer);
  }, [completedRound, roundLocked]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (searchQuery.length < 1) {
        setSearchResults([]);
        return;
      }
      setSearchLoading(true);
      try {
        const data = await autocompleteRosterPlayer(searchQuery);
        setSearchResults(data.players || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  function handleRealtimeState(result) {
    if (!result?.state) return;
    setGame(result.state);
    if (!result.result) {
      setMessage("");
      return;
    }
    if (result.result === "correct") {
      setMessage("Claimed!");
    } else if (result.result === "incorrect") {
      setMessage("No claim — keep racing.");
    } else if (result.result === "round_won") {
      setMessage("Round complete.");
    } else if (result.result === "round_complete") {
      setMessage("Tie round — no point awarded.");
    } else if (result.result === "time_expired") {
      setMessage("Time's up!");
    } else if (result.result === "match_won") {
      setMessage("Match complete!");
    }
    if (result.completedRound) {
      setCompletedRound(result.completedRound);
      setLastRevealedRoundNumber(result.completedRound.round_number);
    }
  }

  const realtime = useOnlineGameRealtime({
    enabled: isOnline,
    gameId: game?.id,
    gameStatus: game?.status,
    playerNumber,
    connect: connectRosterGuessRealtime,
    fetchState: getRosterGame,
    onState: handleRealtimeState,
    onError: setMessage,
  });

  async function handlePlayerSelect(player) {
    setSearchQuery("");
    setSearchResults([]);
    setMessage("");
    const roundNumber = game?.round_number;
    if (!roundNumber) return;
    try {
      if (isOnline) {
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.GUESS, {
          player_id: player.player_id,
          round_number: roundNumber,
        })) {
          setMessage("Realtime connection unavailable. Reconnecting...");
        }
        return;
      }
      handleRealtimeState(await submitRosterGuess(game.id, player.player_id, roundNumber));
    } catch (error) {
      setMessage(error.message);
      if (error.message === "round_stale" || error.message === "round_locked") {
        refreshGame();
      }
    }
  }

  async function refreshGame() {
    if (!game?.id) return;
    try {
      setGame(await getRosterGame(game.id));
    } catch {
      // Polling through useOnlineGameRealtime will retry transient refresh failures.
    }
  }

  async function handleQuickCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelRosterRaceQuickMatch({ preset: game.preset, game_id: game.id });
      clearOnlineInfo(game.id);
      forgetQuickMatchSeat(rosterRaceSeatKey(game.id));
      onNewGame();
    } catch {
      setCancelling(false);
    }
  }

  function handleSearchKeyDown(event) {
    if (event.key === "Escape") {
      setSearchQuery("");
      setSearchResults([]);
      searchInputRef.current?.blur();
    }
    if (event.key === "Enter" && searchResults.length === 1) {
      handlePlayerSelect(searchResults[0]);
    }
  }

  if (game?.status === "waiting_for_opponent") {
    if (game.is_public && game.preset) {
      return (
        <QuickMatchSearchingLobby
          preset={game.preset}
          onCancel={handleQuickCancel}
          cancelling={cancelling}
          usePools={useRosterRaceQuickMatchPools}
          getPresetLabel={rosterRacePresetLabel}
          title="SEARCHING ROSTER RACE..."
        />
      );
    }
    return (
      <WaitingLobby
        joinCode={game.join_code}
        inviteUrl={buildInviteUrl(game.join_code, "/roster")}
        onCancel={onNewGame}
      />
    );
  }

  if (!game || !displayRound) {
    return <LoadingScreen />;
  }

  if (game.status === "finished") {
    return (
      <Shell onHome={onHome}>
        <div className="text-center">
          {completedRound && <CompletedRoundReveal round={completedRound} countdown={0} />}
          <div className="text-5xl mb-3">🏆</div>
          <h1 className="font-display text-4xl text-elq-dark mb-3">
            {(game.winner_player === 1 ? game.player1_name : game.player2_name) || "Player"} wins!
          </h1>
          <p className="text-elq-muted mb-6">{game.player1_score} - {game.player2_score}</p>
          <button onClick={onNewGame} className="px-8 py-3 bg-elq-orange text-white font-bold rounded-xl">
            Play Again
          </button>
        </div>
      </Shell>
    );
  }

  const sortedSlots = [...(displayRound.slots || [])].sort((a, b) => posRank(a.position) - posRank(b.position));

  return (
    <Shell onHome={onHome}>
      <div className="w-full max-w-5xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl text-elq-dark">ROSTER RACE</h1>
            <p className="text-sm text-elq-muted">Claim roster members before your opponent does.</p>
          </div>
          <div className="rounded-full border border-elq-border bg-white px-3 py-1.5 text-xs font-bold text-elq-dark">
            {playerNumber ? `You are ${game[`player${playerNumber}_name`]}` : "Spectating"}
          </div>
        </div>

        <RaceScoreboard
          game={game}
          round={currentRound}
          timerRemaining={roundLocked ? null : timerRemaining}
        />

        <CompletedRoundReveal round={completedRound} countdown={revealRemaining} />

        <section className="mb-4 rounded-3xl border border-elq-border bg-elq-dark text-white shadow-sm overflow-hidden">
          <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <ClubLogo code={displayRound.team_code} size={36} className="flex-shrink-0" />
              <div className="min-w-0">
                <h2 className="font-display text-2xl truncate">{displayRound.team_name}</h2>
                <p className="text-sm text-white/60">{displayRound.season_year}/{String(displayRound.season_year + 1).slice(2)}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-[0.14em]">
              <span className="rounded-full bg-white/10 px-2 py-1">
                {displayRound.guessed_count}/{displayRound.total_slots} claimed
              </span>
              {roundLocked && (
                <span className="rounded-full bg-elq-orange px-2 py-1 text-white">
                  Next round in {revealRemaining}s
                </span>
              )}
            </div>
          </div>
        </section>

        {canGuess && (
          <div className="mb-4 relative z-20">
            <div className="relative">
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                placeholder="Type a player name to claim..."
                className="w-full rounded-2xl border-2 border-elq-border bg-white px-4 py-3 text-sm shadow-sm focus:border-elq-orange focus:outline-none"
              />
              {searchFocused && searchQuery.length >= 1 && (
                <div className="absolute top-full left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-2xl border border-elq-border bg-white shadow-xl">
                  {searchLoading && <div className="px-4 py-3 text-sm text-elq-muted text-center">Searching...</div>}
                  {!searchLoading && searchResults.map((player) => (
                    <button
                      key={player.player_id}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handlePlayerSelect(player)}
                      className="w-full border-b border-elq-border/50 px-4 py-2 text-left text-sm last:border-0 hover:bg-elq-orange/5 hover:text-elq-orange"
                    >
                      {player.full_name}
                    </button>
                  ))}
                  {!searchLoading && searchResults.length === 0 && (
                    <div className="px-4 py-3 text-sm text-elq-muted text-center">No players found</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {message && (
          <div className="mb-4 rounded-xl border border-elq-border bg-white px-3 py-2 text-center text-sm font-semibold text-elq-text shadow-sm">
            {message}
          </div>
        )}

        <div className="grid gap-2">
          {sortedSlots.map((slot) => (
            <RaceSlot key={slot.id} slot={slot} />
          ))}
        </div>
      </div>
    </Shell>
  );
}

function RaceScoreboard({ game, round, timerRemaining }) {
  return (
    <section className="mb-4 rounded-3xl border border-elq-border bg-white shadow-sm overflow-hidden">
      <div className="h-1.5 bg-gradient-to-r from-elq-player1 via-elq-orange to-elq-player2" />
      <div className="p-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <PlayerScore name={game.player1_name} score={game.player1_score} claims={round?.player1_correct || 0} tone="player1" />
        <div className="text-center">
          <div className="font-display text-2xl text-elq-dark">VS</div>
          <div className="text-xs text-elq-muted">Round {game.round_number} · First to {game.target_wins}</div>
          {timerRemaining != null && (
            <div className={`mt-1 font-mono text-lg font-bold ${timerRemaining <= 10 ? "text-elq-warning" : "text-elq-dark"}`}>
              {timerRemaining}s
            </div>
          )}
        </div>
        <PlayerScore name={game.player2_name} score={game.player2_score} claims={round?.player2_correct || 0} tone="player2" align="right" />
      </div>
    </section>
  );
}

function PlayerScore({ name, score, claims, tone, align = "left" }) {
  const color = tone === "player2" ? "text-elq-player2" : "text-elq-player1";
  return (
    <div className={align === "right" ? "text-right" : ""}>
      <div className={`text-sm font-bold truncate ${color}`}>{name}</div>
      <div className="text-3xl font-display text-elq-dark">{score}</div>
      <div className="text-xs text-elq-muted">{claims} claims this round</div>
    </div>
  );
}

function RaceSlot({ slot }) {
  const claimedBy = slot.guessed_by_player;
  const claimed = claimedBy === 1 || claimedBy === 2;
  const classes = claimedBy === 1
    ? "border-elq-player1/30 bg-elq-player1-bg"
    : claimedBy === 2
      ? "border-elq-player2/30 bg-elq-player2-bg"
      : slot.player_name
        ? "border-amber-200 bg-amber-50"
        : "border-elq-border bg-white";
  return (
    <div className={`flex items-center gap-3 rounded-2xl border px-3 py-2 ${classes}`}>
      <div className="h-10 w-10 rounded-xl bg-slate-100 overflow-hidden flex items-center justify-center">
        {slot.image_url ? (
          <img src={slot.image_url} alt={slot.player_name || "Player"} className="h-full w-full object-cover object-top" />
        ) : (
          <span className="text-slate-300 font-bold">?</span>
        )}
      </div>
      <div className="w-8 text-center font-mono text-sm font-bold text-slate-500">{slot.jersey_number || "?"}</div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-sm font-semibold text-elq-dark">{slot.player_name || "???"}</div>
        <div className="text-xs text-elq-muted">{[slot.position, slot.nationality].filter(Boolean).join(" · ")}</div>
      </div>
      {claimed && (
        <div className={`rounded-full px-2 py-1 text-xs font-bold ${claimedBy === 1 ? "bg-elq-player1 text-white" : "bg-elq-player2 text-white"}`}>
          P{claimedBy}
        </div>
      )}
    </div>
  );
}

function CompletedRoundReveal({ round, countdown }) {
  if (!round) return null;
  return (
    <div className="mb-4 rounded-3xl border border-elq-orange/30 bg-elq-orange/10 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-display text-2xl text-elq-dark">
            {round.winner_player ? `Player ${round.winner_player} wins the round` : "Tie round"}
          </div>
          <div className="text-sm text-elq-muted">
            {round.player1_correct} - {round.player2_correct} · Full roster revealed
          </div>
        </div>
        {countdown > 0 && (
          <div className="rounded-full bg-elq-orange px-3 py-1 text-sm font-bold text-white">
            Next in {countdown}s
          </div>
        )}
      </div>
    </div>
  );
}

function Shell({ children, onHome }) {
  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-player1 via-elq-orange to-elq-player2" />
      <div className="bg-white border-b border-elq-border">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <BoardHeaderNav onHome={onHome} />
          <span className="font-display text-base tracking-wide text-elq-dark">ROSTER RACE</span>
          <span />
        </div>
      </div>
      <main className="flex-1 bg-elq-bg p-4 flex justify-center">
        {children}
      </main>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <svg className="w-8 h-8 text-elq-orange animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </div>
  );
}

function secondsUntil(value, nowMs) {
  if (!value) return null;
  const remaining = Math.ceil((new Date(value).getTime() - nowMs) / 1000);
  return Math.max(0, remaining);
}
