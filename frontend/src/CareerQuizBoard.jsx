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
const CAREER_FEEDBACK_MESSAGES = {
  correct: "Correct!",
  soloWrong: "Not this player. Keep guessing.",
  multiplayerWrong: "Wrong guess.",
  noAnswerOfferSent: "No-answer offer sent.",
};
const CAREER_MULTIPLAYER_SUCCESS_RESULTS = new Set(["round_won", "match_won"]);
const NO_ANSWER_OFFER_SENT_MESSAGE = CAREER_FEEDBACK_MESSAGES.noAnswerOfferSent;
const CAREER_FEEDBACK_TONES = {
  [CAREER_FEEDBACK_MESSAGES.correct]: "success",
  [CAREER_FEEDBACK_MESSAGES.soloWrong]: "error",
  [CAREER_FEEDBACK_MESSAGES.multiplayerWrong]: "error",
  [CAREER_FEEDBACK_MESSAGES.noAnswerOfferSent]: "neutral",
};
const CAREER_FEEDBACK_STYLES = {
  success: {
    container: "border-emerald-200 bg-emerald-50 text-emerald-700",
    dot: "bg-elq-success",
  },
  error: {
    container: "border-red-200 bg-red-50 text-red-600",
    dot: "bg-elq-player2",
  },
  neutral: {
    container: "border-amber-200 bg-amber-50 text-amber-700",
    dot: "bg-elq-warning",
  },
  info: {
    container: "border-slate-200 bg-slate-100 text-slate-600",
    dot: "bg-slate-400",
  },
};

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
  const [noAnswerOfferMessageRoundNumber, setNoAnswerOfferMessageRoundNumber] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const solo = Boolean(soloRound);
  const playerNumber = onlineInfo?.playerNumber || 1;
  const timeline = solo ? soloRound.timeline : game?.current_round?.timeline || [];
  const currentRoundNumber = getCareerGameRoundNumber(game);
  const revealNextRoundStartsAt = completedRound?.next_round_starts_at
    || game?.latest_completed_round?.next_round_starts_at
    || null;
  const revealCountdownRemaining = getRevealCountdownRemaining(revealNextRoundStartsAt, nowMs);
  const roundLocked = revealCountdownRemaining > 0;
  const sharedWrongGuesses = solo ? [] : game?.current_round?.wrong_guesses || [];

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
    if (message !== NO_ANSWER_OFFER_SENT_MESSAGE || solo) return;

    const offerStillPendingFromPlayer = (
      game?.pending_no_answer_from === playerNumber
      && game?.pending_no_answer_to != null
    );
    const activeRoundNumber = getCareerGameRoundNumber(game);
    const latestCompletedRoundNumber = game?.latest_completed_round?.round_number ?? null;
    const offerRoundChanged = (
      noAnswerOfferMessageRoundNumber != null
      && activeRoundNumber != null
      && activeRoundNumber !== noAnswerOfferMessageRoundNumber
    );
    const offerRoundCompleted = (
      noAnswerOfferMessageRoundNumber != null
      && latestCompletedRoundNumber != null
      && latestCompletedRoundNumber >= noAnswerOfferMessageRoundNumber
    );

    if (!offerStillPendingFromPlayer || offerRoundChanged || offerRoundCompleted) {
      setMessage("");
      setNoAnswerOfferMessageRoundNumber(null);
    }
  }, [game, message, noAnswerOfferMessageRoundNumber, playerNumber, solo]);

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
    setNoAnswerOfferMessageRoundNumber(null);
  }

  async function handleGuess(player) {
    setMessage("");
    setNoAnswerOfferMessageRoundNumber(null);
    if (solo) {
      const result = await submitCareerSoloGuess(soloRound.round_token, player.id);
      if (result.correct) {
        setAnswer(result.answer);
        setRecentIds((ids) => [...ids.slice(-19), result.answer.id]);
        setMessage(CAREER_FEEDBACK_MESSAGES.correct);
      } else {
        setMessage(CAREER_FEEDBACK_MESSAGES.soloWrong);
      }
      return;
    }
    try {
      const result = await submitCareerGuess(game.id, playerNumber, player.id, currentRoundNumber);
      setGame(result.state);
      setMessage(getCareerMultiplayerGuessMessage(result.result));
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
      setNoAnswerOfferMessageRoundNumber(getCareerGameRoundNumber(result.state) ?? currentRoundNumber);
      setMessage(NO_ANSWER_OFFER_SENT_MESSAGE);
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
    setNoAnswerOfferMessageRoundNumber(null);
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
        <div className={`flex items-start justify-between gap-4 ${solo ? "mb-6" : "mb-4"}`}>
          <div>
            <h1 className="font-display text-4xl text-elq-dark">CAREER QUIZ</h1>
            <p className="text-sm text-elq-muted">Career data from Wikipedia and may be incomplete.</p>
          </div>
        </div>

        {!solo && (
          <CareerMultiplayerScoreboard
            game={game}
            playerNumber={playerNumber}
            roundNumber={currentRoundNumber}
          />
        )}

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

            <CareerFeedbackMessage message={message} />

            <SharedWrongGuesses
              guesses={sharedWrongGuesses}
              player1Name={game?.player1_name}
              player2Name={game?.player2_name}
            />

            {answer ? (
              <div className="mt-6 rounded-2xl border border-elq-border bg-white p-5">
                <div className="flex items-center gap-4 mb-4">
                  <AnswerPlayerImage player={answer} />
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

function getCareerMultiplayerGuessMessage(result) {
  if (result === "incorrect") return CAREER_FEEDBACK_MESSAGES.multiplayerWrong;
  if (CAREER_MULTIPLAYER_SUCCESS_RESULTS.has(result)) return CAREER_FEEDBACK_MESSAGES.correct;
  return "";
}

function CareerFeedbackMessage({ message }) {
  if (!message) return null;

  const tone = CAREER_FEEDBACK_TONES[message] || "info";
  const styles = CAREER_FEEDBACK_STYLES[tone];

  return (
    <div
      role="status"
      data-testid="career-feedback-message"
      className={`mt-4 flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm animate-slide-down ${styles.container}`}
    >
      <span className={`h-2 w-2 rounded-full ${styles.dot}`} />
      <span>{message}</span>
    </div>
  );
}

function CareerMultiplayerScoreboard({ game, playerNumber, roundNumber }) {
  const player1Name = game?.player1_name || "Player 1";
  const player2Name = game?.player2_name || "Player 2";
  const targetWins = game?.target_wins ?? "-";
  const youName = game?.[`player${playerNumber}_name`] || `Player ${playerNumber}`;
  const youClasses = playerNumber === 2
    ? {
      pill: "border-elq-player2/25 bg-elq-player2-bg",
      dot: "bg-elq-player2",
    }
    : {
      pill: "border-elq-player1/25 bg-elq-player1-bg",
      dot: "bg-elq-player1",
    };

  return (
    <section
      role="group"
      aria-label="Career Quiz multiplayer scoreboard"
      className="mb-6 overflow-hidden rounded-3xl border border-elq-border bg-white shadow-sm animate-fade-in-up"
    >
      <div className="h-1.5 bg-gradient-to-r from-elq-player1 via-elq-orange to-elq-player2" />
      <div className="p-4 sm:p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-display text-2xl tracking-wide text-elq-dark">ONLINE RACE</div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold uppercase tracking-[0.16em] text-elq-dark">
              <span className="rounded-full bg-elq-bg px-2 py-0.5">
                {roundNumber != null ? `Round ${roundNumber}` : "Round -"}
              </span>
              <span className="rounded-full border border-elq-orange/30 bg-elq-orange/10 px-2 py-0.5">
                First to {targetWins}
              </span>
            </div>
          </div>
          <div
            className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold text-elq-dark ${youClasses.pill}`}
          >
            <span className={`h-2 w-2 rounded-full ${youClasses.dot}`} />
            <span>You are {youName}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-[1fr_auto_1fr] sm:gap-4">
          <CareerPlayerScore
            label="Player 1"
            name={player1Name}
            score={game?.player1_score ?? 0}
            tone="player1"
          />
          <div className="flex items-center justify-center">
            <div className="rounded-full border border-elq-border bg-elq-bg px-3 py-1 font-display text-xl tracking-wide text-elq-dark">
              VS
            </div>
          </div>
          <CareerPlayerScore
            label="Player 2"
            name={player2Name}
            score={game?.player2_score ?? 0}
            tone="player2"
            align="right"
          />
        </div>
      </div>
    </section>
  );
}

function CareerPlayerScore({ label, name, score, tone, align = "left" }) {
  const toneClasses = tone === "player2"
    ? {
      bar: "right-0 bg-elq-player2",
      panel: "border-elq-player2/25 bg-elq-player2-bg/70",
      text: "text-elq-player2",
    }
    : {
      bar: "left-0 bg-elq-player1",
      panel: "border-elq-player1/25 bg-elq-player1-bg/70",
      text: "text-elq-player1",
    };

  return (
    <div
      aria-label={`${name} score ${score}`}
      className={`relative overflow-hidden rounded-2xl border p-4 ${toneClasses.panel}`}
    >
      <div className={`absolute inset-y-0 w-1.5 ${toneClasses.bar}`} />
      <div className={`flex items-end justify-between gap-4 ${align === "right" ? "sm:flex-row-reverse sm:text-right" : ""}`}>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-elq-dark">
            {label}
          </div>
          <div className="mt-1 truncate text-base font-bold text-elq-dark sm:text-lg">{name}</div>
        </div>
        <div className={`font-display text-5xl font-bold leading-none sm:text-6xl ${toneClasses.text}`}>
          {score}
        </div>
      </div>
    </div>
  );
}

function SharedWrongGuesses({ guesses, player1Name, player2Name }) {
  if (!guesses.length) return null;

  return (
    <div className="mt-4 rounded-2xl border border-elq-border bg-white p-3" aria-label="Shared wrong guesses">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-elq-muted">
        Shared wrong guesses
      </div>
      <div className="flex flex-wrap gap-2">
        {guesses.map((guess, index) => {
          const playerLabel = guess.player_number === 1
            ? player1Name || "Player 1"
            : player2Name || "Player 2";
          const classes = guess.player_number === 1
            ? "border-elq-player1/20 bg-elq-player1-bg text-elq-player1"
            : "border-elq-player2/20 bg-elq-player2-bg text-elq-player2";

          return (
            <div
              key={`${guess.player_number}-${guess.player?.id ?? index}`}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${classes}`}
            >
              <span>{playerLabel}</span>
              <span className="text-elq-muted">guessed</span>
              <span>{guess.player?.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompletedRoundReveal({ round, countdownRemaining = 0 }) {
  if (!round) return null;
  return (
    <div className="mb-5 rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-emerald-900 flex items-center gap-4">
      <AnswerPlayerImage player={round.answer} />
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

function AnswerPlayerImage({ player }) {
  if (!player?.image_url) return null;
  return (
    <img
      src={player.image_url}
      alt={player.name || ""}
      className="w-20 h-20 rounded-full object-cover object-top border border-elq-border shrink-0"
      onError={(e) => { e.target.style.display = "none"; }}
    />
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

function getCareerGameRoundNumber(game) {
  return game?.current_round?.round_number ?? game?.round_number ?? null;
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

  function selectPlayer(player) {
    onGuess(player);
    setQuery("");
    setPlayers([]);
  }

  function handleKeyDown(event) {
    if (disabled) return;
    if (event.key === "Enter" && players.length === 1) {
      selectPlayer(players[0]);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-elq-border p-4">
      <input
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a player name..."
        className="w-full px-4 py-3 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:outline-none"
      />
      {players.length > 0 && (
        <div className="mt-2 rounded-xl border border-elq-border overflow-hidden">
          {players.map((player) => (
            <button
              key={player.id}
              onClick={() => selectPlayer(player)}
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
