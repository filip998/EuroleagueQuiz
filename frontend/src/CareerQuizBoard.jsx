import { useEffect, useState } from "react";
import {
  autocompleteCareerPlayer,
  createCareerSoloRound,
  getCareerGame,
  offerCareerNoAnswer,
  revealCareerSoloAnswer,
  respondCareerNoAnswer,
  submitCareerGuess,
  submitCareerSoloGuess,
} from "./api";

export const CAREER_REVEAL_COUNTDOWN_SECONDS = 3;

export default function CareerQuizBoard({ initialState, soloInitialRound, onlineInfo, onNewGame, onHome }) {
  const [soloRound, setSoloRound] = useState(soloInitialRound || null);
  const [recentIds, setRecentIds] = useState([]);
  const [game, setGame] = useState(initialState || null);
  const [completedRound, setCompletedRound] = useState(null);
  const [lastRevealedRoundNumber, setLastRevealedRoundNumber] = useState(
    initialState?.latest_completed_round?.round_number ?? null
  );
  const [answer, setAnswer] = useState(null);
  const [message, setMessage] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const solo = Boolean(soloRound);
  const playerNumber = onlineInfo?.playerNumber || 1;
  const timeline = solo ? soloRound.timeline : game?.current_round?.timeline || [];
  const currentRoundNumber = game?.current_round?.round_number ?? game?.round_number ?? null;
  const revealNextRoundStartsAt = completedRound?.next_round_starts_at
    || game?.latest_completed_round?.next_round_starts_at
    || null;
  const revealCountdownRemaining = getRevealCountdownRemaining(revealNextRoundStartsAt, nowMs);
  const roundLocked = revealCountdownRemaining > 0;

  useEffect(() => {
    if (!revealNextRoundStartsAt) return undefined;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [revealNextRoundStartsAt]);

  useEffect(() => {
    if (!completedRound) return undefined;
    const timer = setTimeout(() => setCompletedRound(null), 3000);
    return () => clearTimeout(timer);
  }, [completedRound]);

  useEffect(() => {
    const latestRound = game?.latest_completed_round;
    if (!shouldRevealCompletedRound(latestRound, lastRevealedRoundNumber)) return;
    setCompletedRound(latestRound);
    setLastRevealedRoundNumber(latestRound.round_number);
  }, [game?.latest_completed_round, lastRevealedRoundNumber]);

  useEffect(() => {
    if (solo || !game?.id || game.status === "finished") return undefined;
    const timer = setInterval(async () => {
      try {
        setGame(await getCareerGame(game.id));
      } catch {
        // Keep the local state; transient polling failures should not kick users out.
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [solo, game?.id, game?.status]);

  async function nextSoloRound() {
    const next = await createCareerSoloRound(recentIds);
    setSoloRound(next);
    setAnswer(null);
    setMessage("");
  }

  async function handleGuess(player) {
    setMessage("");
    if (solo) {
      const result = await submitCareerSoloGuess(soloRound.round_token, player.id);
      if (result.correct) {
        setAnswer(result.answer);
        setRecentIds((ids) => [...ids.slice(-19), result.answer.id]);
        setMessage("Correct!");
      } else {
        setMessage("Not this player. Keep guessing.");
      }
      return;
    }
    try {
      const result = await submitCareerGuess(game.id, playerNumber, player.id, currentRoundNumber);
      setGame(result.state);
      setMessage(result.result === "incorrect" ? "Wrong guess." : "");
    } catch (error) {
      if (isCareerActionSyncConflict(error)) {
        await resyncCareerGame();
        return;
      }
      throw error;
    }
  }

  async function revealSolo() {
    const result = await revealCareerSoloAnswer(soloRound.round_token);
    setAnswer(result.answer);
    setRecentIds((ids) => [...ids.slice(-19), result.answer.id]);
  }

  async function offerNoAnswer() {
    try {
      const result = await offerCareerNoAnswer(game.id, playerNumber, currentRoundNumber);
      setGame(result.state);
      setMessage("No-answer offer sent.");
    } catch (error) {
      if (isCareerActionSyncConflict(error)) {
        await resyncCareerGame();
        return;
      }
      throw error;
    }
  }

  async function respondNoAnswer(accept) {
    try {
      const result = await respondCareerNoAnswer(game.id, playerNumber, accept, currentRoundNumber);
      setGame(result.state);
    } catch (error) {
      if (isCareerActionSyncConflict(error)) {
        await resyncCareerGame();
        return;
      }
      throw error;
    }
  }

  async function resyncCareerGame() {
    setMessage("");
    if (!game?.id) return;
    try {
      setGame(await getCareerGame(game.id));
    } catch {
      // Regular polling will retry transient refresh failures.
    }
  }

  if (game?.status === "waiting_for_opponent") {
    return (
      <Shell onHome={onHome}>
        <div className="text-center">
          <h1 className="font-display text-4xl text-elq-dark mb-2">WAITING FOR OPPONENT</h1>
          <p className="text-elq-muted mb-4">Share this code</p>
          <div className="font-mono text-5xl tracking-[0.3em] bg-elq-bg rounded-2xl px-8 py-5 border-2 border-dashed border-elq-orange/30">
            {game.join_code}
          </div>
        </div>
      </Shell>
    );
  }

  if (game?.status === "finished") {
    return (
      <Shell onHome={onHome}>
        <div className="text-center">
          <CompletedRoundReveal
            round={completedRound}
            countdownRemaining={revealCountdownRemaining}
          />
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

  return (
    <Shell onHome={onHome}>
      <div className="w-full max-w-5xl">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="font-display text-4xl text-elq-dark">CAREER QUIZ</h1>
            <p className="text-sm text-elq-muted">Career data from Wikipedia and may be incomplete.</p>
          </div>
          {!solo && (
            <div className="text-right text-sm">
              <div className="font-bold text-elq-dark">{game.player1_name}: {game.player1_score}</div>
              <div className="font-bold text-elq-dark">{game.player2_name}: {game.player2_score}</div>
            </div>
          )}
        </div>

        <CompletedRoundReveal
          round={completedRound}
          countdownRemaining={revealCountdownRemaining}
        />

        <div className="grid lg:grid-cols-2 gap-6 items-start">
          <div className="lg:max-h-[60vh] lg:overflow-y-auto">
            <Timeline timeline={timeline} />
          </div>

          <div>
            <CareerGuessBox onGuess={handleGuess} disabled={Boolean(answer) || roundLocked} />

            {message && <p className="mt-4 text-sm text-elq-muted">{message}</p>}

            {answer ? (
              <div className="mt-6 rounded-2xl border border-elq-border bg-white p-5">
                <div className="flex items-center gap-4 mb-4">
                  {answer.image_url && (
                    <img
                      src={answer.image_url}
                      alt={answer.name || ""}
                      className="w-20 h-20 rounded-full object-cover object-top border border-elq-border shrink-0"
                      onError={(e) => { e.target.style.display = "none"; }}
                    />
                  )}
                  <div>
                    <h2 className="font-display text-3xl text-elq-dark">{answer.name}</h2>
                    <p className="text-sm text-elq-muted">
                      {[answer.position, answer.nationality].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
                <button onClick={nextSoloRound} className="px-6 py-3 rounded-xl bg-elq-orange text-white font-bold">
                  Next career
                </button>
              </div>
            ) : (
              <div className="mt-6 flex flex-wrap gap-3">
                {solo && (
                  <button onClick={revealSolo} className="px-5 py-2 rounded-xl border border-elq-border text-elq-text">
                    Reveal answer
                  </button>
                )}
                {!solo && game?.pending_no_answer_to === playerNumber && (
                  <>
                    <button
                      onClick={() => respondNoAnswer(true)}
                      disabled={roundLocked}
                      className="px-5 py-2 rounded-xl bg-elq-orange text-white font-bold disabled:opacity-50"
                    >
                      Accept no answer
                    </button>
                    <button
                      onClick={() => respondNoAnswer(false)}
                      disabled={roundLocked}
                      className="px-5 py-2 rounded-xl border border-elq-border disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </>
                )}
                {!solo && !game?.pending_no_answer_to && (
                  <button
                    onClick={offerNoAnswer}
                    disabled={roundLocked}
                    className="px-5 py-2 rounded-xl border border-elq-border text-elq-text disabled:opacity-50"
                  >
                    Nobody knows
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function CompletedRoundReveal({ round, countdownRemaining = 0 }) {
  if (!round) return null;
  return (
    <div className="mb-5 rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-emerald-900 flex items-center gap-4">
      {round.answer?.image_url && (
        <img
          src={round.answer.image_url}
          alt={round.answer?.name || ""}
          className="w-14 h-14 rounded-full object-cover object-top border border-emerald-300 shrink-0"
          onError={(e) => { e.target.style.display = "none"; }}
        />
      )}
      <div>
        <strong>{round.winner_player ? `Player ${round.winner_player} wins the round` : "No answer"}</strong>
        <div>Answer: {round.answer?.name}</div>
        {round.next_round_starts_at && (
          <div className="text-sm font-semibold">
            {countdownRemaining > 0
              ? `Next round unlocks in ${countdownRemaining}`
              : "Next round unlocked"}
          </div>
        )}
      </div>
    </div>
  );
}

function Timeline({ timeline }) {
  return (
    <div className="bg-white rounded-3xl border border-elq-border shadow-sm p-5 mb-5">
      <div className="space-y-3">
        {timeline.map((stint, index) => (
          <div key={`${stint.team_name}-${index}`} className="flex items-center justify-between gap-4 border-b border-elq-border last:border-b-0 pb-3 last:pb-0">
            <div>
              <div className="font-bold text-elq-dark">{stint.team_name}</div>
              {stint.is_loan && <div className="text-xs text-elq-orange font-semibold">Loan</div>}
            </div>
            <div className="text-sm text-elq-muted whitespace-nowrap">
              {formatSeasonRange(stint)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function formatSeasonRange(stint) {
  if (stint.years) return stint.years;
  if (!stint.end_season) return `${stint.start_season} – present`;
  if (stint.end_season === stint.start_season) return stint.start_season;
  const startYear = Number.parseInt(String(stint.start_season).slice(0, 4), 10);
  const endYear = Number.parseInt(String(stint.end_season).slice(0, 4), 10);
  if (Number.isFinite(startYear) && Number.isFinite(endYear) && endYear < startYear) {
    return stint.start_season;
  }
  return `${stint.start_season} – ${stint.end_season}`;
}

export function shouldRevealCompletedRound(latestRound, lastRevealedRoundNumber) {
  return (
    latestRound?.round_number != null
    && latestRound.round_number !== lastRevealedRoundNumber
  );
}

export function getRevealCountdownRemaining(nextRoundStartsAt, nowMs = Date.now()) {
  if (!nextRoundStartsAt) return 0;
  const startsAtMs = Date.parse(nextRoundStartsAt);
  if (!Number.isFinite(startsAtMs)) return 0;
  return Math.min(
    CAREER_REVEAL_COUNTDOWN_SECONDS,
    Math.max(0, Math.ceil((startsAtMs - nowMs) / 1000))
  );
}

function isCareerActionSyncConflict(error) {
  return [
    error?.message,
    error?.detail,
    error?.payload?.message,
    error?.payload?.code,
  ].some((code) => code === "round_locked" || code === "round_stale");
}

function CareerGuessBox({ onGuess, disabled }) {
  const [query, setQuery] = useState("");
  const [players, setPlayers] = useState([]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!query || disabled) {
        setPlayers([]);
        return;
      }
      try {
        const result = await autocompleteCareerPlayer(query);
        setPlayers(result.players || []);
      } catch {
        setPlayers([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, disabled]);

  return (
    <div className="bg-white rounded-2xl border border-elq-border p-4">
      <input
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Type a player name..."
        className="w-full px-4 py-3 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:outline-none"
      />
      {players.length > 0 && (
        <div className="mt-2 rounded-xl border border-elq-border overflow-hidden">
          {players.map((player) => (
            <button
              key={player.id}
              onClick={() => {
                onGuess(player);
                setQuery("");
                setPlayers([]);
              }}
              className="block w-full text-left px-4 py-2 hover:bg-elq-orange/5"
            >
              {player.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ children, onHome }) {
  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
      <div className="p-4">
        <button onClick={onHome} className="text-sm text-elq-muted hover:text-elq-orange">
          ← Home
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center p-4 pt-0">
        {children}
      </div>
    </div>
  );
}
