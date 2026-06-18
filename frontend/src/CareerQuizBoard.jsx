import { useEffect, useRef, useState } from "react";
import {
  autocompleteCareerPlayer,
  connectCareerRealtime,
  createCareerSoloRound,
  fetchCareerSoloHint,
  getCareerGame,
  offerCareerNoAnswer,
  revealCareerSoloAnswer,
  respondCareerNoAnswer,
  submitCareerGuess,
  submitCareerSoloGuess,
} from "./api";
import { REALTIME_CLIENT_ACTIONS } from "./realtimeSchema";
import { useOnlineGameRealtime } from "./useOnlineGameRealtime";
import WaitingLobby from "./WaitingLobby";
import {
  formatSeasonRange,
  getRevealCountdownRemaining,
  shouldRevealCompletedRound,
} from "./careerQuizUtils";
const CAREER_FEEDBACK_MESSAGES = {
  correct: "Correct!",
  soloWrong: "Not this player. Keep guessing.",
  multiplayerWrong: "Wrong guess.",
  noAnswerOfferSent: "No-answer offer sent.",
  realtimeUnavailable: "Realtime connection unavailable. Reconnecting...",
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
const SOLO_HINT_TYPES = {
  nationality: "nationality",
  position: "position",
  nameSkeleton: "name_skeleton",
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
  const [soloHints, setSoloHints] = useState(createEmptySoloHints);
  const [soloHintLoading, setSoloHintLoading] = useState(false);
  const [soloHintError, setSoloHintError] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const soloRoundTokenRef = useRef(soloInitialRound?.round_token || null);

  const solo = Boolean(soloRound);
  const isOnline = !solo && Boolean(onlineInfo);
  const playerNumber = onlineInfo?.playerNumber || 1;
  const timeline = solo ? soloRound.timeline : game?.current_round?.timeline || [];
  const currentRoundNumber = getCareerGameRoundNumber(game);
  const roundKey = solo ? soloRound?.round_token : currentRoundNumber;
  const revealNextRoundStartsAt = completedRound?.next_round_starts_at
    || game?.latest_completed_round?.next_round_starts_at
    || null;
  const revealCountdownRemaining = getRevealCountdownRemaining(revealNextRoundStartsAt, nowMs);
  const roundLocked = revealCountdownRemaining > 0;
  const sharedWrongGuesses = solo ? [] : game?.current_round?.wrong_guesses || [];

  useEffect(() => {
    soloRoundTokenRef.current = soloRound?.round_token || null;
  }, [soloRound?.round_token]);

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

  function handleRealtimeState(result) {
    if (!result?.state) return;
    setGame(result.state);

    if (!result.result) {
      setMessage((currentMessage) => (
        currentMessage === NO_ANSWER_OFFER_SENT_MESSAGE ? currentMessage : ""
      ));
      return;
    }
    if (result.result === "no_answer_offered") {
      if (result.state.pending_no_answer_from === playerNumber) {
        setNoAnswerOfferMessageRoundNumber(
          getCareerGameRoundNumber(result.state) ?? currentRoundNumber
        );
        setMessage(NO_ANSWER_OFFER_SENT_MESSAGE);
      }
      return;
    }

    if (result.result?.startsWith("no_answer_")) {
      setNoAnswerOfferMessageRoundNumber(null);
      setMessage("");
      return;
    }

    const nextMessage = getCareerMultiplayerGuessMessage(result.result);
    if (nextMessage) {
      if (shouldShowCareerMultiplayerFeedback(result, playerNumber)) {
        setNoAnswerOfferMessageRoundNumber(null);
        setMessage(nextMessage);
      } else {
        setMessage((currentMessage) => (
          currentMessage === NO_ANSWER_OFFER_SENT_MESSAGE ? currentMessage : ""
        ));
      }
    }
  }

  async function handleRealtimeError(errorMessage) {
    if (isCareerActionSyncConflict({ message: errorMessage })) {
      await resyncCareerGame();
      return;
    }
    setMessage(errorMessage || CAREER_FEEDBACK_MESSAGES.realtimeUnavailable);
  }

  const realtime = useOnlineGameRealtime({
    enabled: isOnline,
    gameId: game?.id,
    gameStatus: game?.status,
    playerNumber,
    connect: connectCareerRealtime,
    fetchState: getCareerGame,
    onState: handleRealtimeState,
    onError: handleRealtimeError,
  });

  async function nextSoloRound() {
    const next = await createCareerSoloRound(recentIds);
    soloRoundTokenRef.current = next.round_token || null;
    setSoloRound(next);
    setAnswer(null);
    setMessage("");
    setNoAnswerOfferMessageRoundNumber(null);
    setSoloHints(createEmptySoloHints());
    setSoloHintError("");
    setSoloHintLoading(false);
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
      if (isOnline) {
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.GUESS, {
          player_id: player.id,
          round_number: currentRoundNumber,
        })) {
          setMessage(CAREER_FEEDBACK_MESSAGES.realtimeUnavailable);
        }
        return;
      }

      const result = await submitCareerGuess(game.id, playerNumber, player.id, currentRoundNumber);
      handleRealtimeState(result);
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

  async function revealSoloHint() {
    if (!soloRound?.round_token || soloHints.exhausted || soloHintLoading) return;
    const requestedRoundToken = soloRound.round_token;
    setSoloHintLoading(true);
    setSoloHintError("");
    const progress = {
      shown_hints: soloHints.shownHints,
      revealed_letters: soloHints.revealedLetters,
    };
    try {
      const hint = await fetchCareerSoloHint(requestedRoundToken, progress);
      if (soloRoundTokenRef.current !== requestedRoundToken) return;
      setSoloHints((current) => applySoloHint(current, hint));
    } catch {
      if (soloRoundTokenRef.current !== requestedRoundToken) return;
      setSoloHintError("Could not load a hint. Try again.");
    } finally {
      if (soloRoundTokenRef.current === requestedRoundToken) {
        setSoloHintLoading(false);
      }
    }
  }

  async function offerNoAnswer() {
    try {
      if (isOnline) {
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.OFFER_NO_ANSWER, {
          round_number: currentRoundNumber,
        })) {
          setMessage(CAREER_FEEDBACK_MESSAGES.realtimeUnavailable);
        }
        return;
      }

      const result = await offerCareerNoAnswer(game.id, playerNumber, currentRoundNumber);
      handleRealtimeState(result);
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
      if (isOnline) {
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.RESPOND_NO_ANSWER, {
          accept,
          round_number: currentRoundNumber,
        })) {
          setMessage(CAREER_FEEDBACK_MESSAGES.realtimeUnavailable);
        }
        return;
      }

      const result = await respondCareerNoAnswer(game.id, playerNumber, accept, currentRoundNumber);
      handleRealtimeState(result);
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
    return <WaitingLobby joinCode={game.join_code} onCancel={onNewGame} />;
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
            <CareerGuessBox
              onGuess={handleGuess}
              disabled={Boolean(answer) || roundLocked}
              roundKey={roundKey}
            />

            {solo && (
              <SoloHintsPanel
                hints={soloHints}
                loading={soloHintLoading}
                error={soloHintError}
                disabled={Boolean(answer)}
                onReveal={revealSoloHint}
              />
            )}

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

function shouldShowCareerMultiplayerFeedback(message, playerNumber) {
  if (message.result === "incorrect") {
    const wrongGuesses = message.state?.current_round?.wrong_guesses;
    if (!Array.isArray(wrongGuesses) || wrongGuesses.length === 0) return true;
    return wrongGuesses[wrongGuesses.length - 1]?.player_number === playerNumber;
  }

  if (CAREER_MULTIPLAYER_SUCCESS_RESULTS.has(message.result)) {
    const winnerPlayer =
      message.completedRound?.winner_player
      ?? message.state?.latest_completed_round?.winner_player;
    return winnerPlayer === playerNumber;
  }

  return true;
}

function createEmptySoloHints() {
  return {
    shownHints: [],
    revealedLetters: [],
    revealedPositions: {},
    nationality: null,
    countryCode: null,
    position: null,
    skeleton: null,
    exhausted: false,
    usedCount: 0,
  };
}

function applySoloHint(current, hint) {
  if (hint?.type === "exhausted") {
    return { ...current, exhausted: true };
  }

  if (hint?.type === SOLO_HINT_TYPES.nationality) {
    return {
      ...current,
      shownHints: addUnique(current.shownHints, SOLO_HINT_TYPES.nationality),
      nationality: hint.nationality || "Unknown",
      countryCode: hint.country_code || null,
      usedCount: current.usedCount + 1,
    };
  }

  if (hint?.type === SOLO_HINT_TYPES.position) {
    return {
      ...current,
      shownHints: addUnique(current.shownHints, SOLO_HINT_TYPES.position),
      position: hint.position || "Unknown",
      usedCount: current.usedCount + 1,
    };
  }

  if (hint?.type === SOLO_HINT_TYPES.nameSkeleton) {
    return {
      ...current,
      shownHints: addUnique(current.shownHints, SOLO_HINT_TYPES.nameSkeleton),
      skeleton: hint.skeleton || [],
      usedCount: current.usedCount + 1,
    };
  }

  if (hint?.type === "letter_reveal") {
    const revealedPositions = { ...current.revealedPositions };
    for (const position of hint.positions || []) {
      revealedPositions[position] = hint.letter;
    }
    return {
      ...current,
      revealedLetters: addUnique(current.revealedLetters, hint.letter),
      revealedPositions,
      usedCount: current.usedCount + 1,
    };
  }

  return current;
}

function addUnique(values, value) {
  if (!value || values.includes(value)) return values;
  return [...values, value];
}

function SoloHintsPanel({ hints, loading, error, disabled, onReveal }) {
  const exhausted = hints.exhausted;
  const buttonDisabled = disabled || loading || exhausted;
  const buttonLabel = exhausted
    ? "No more hints"
    : loading ? "Loading hint..." : "Reveal a hint";

  return (
    <section
      aria-label="Solo career hints"
      data-testid="career-solo-hints"
      className="mt-4 rounded-2xl border border-elq-border bg-white p-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-elq-muted">
            Solo hints
          </div>
          <div className="text-sm font-semibold text-elq-dark">
            Hints used: {hints.usedCount}
          </div>
        </div>
        <button
          onClick={onReveal}
          disabled={buttonDisabled}
          className="rounded-xl border border-elq-orange/30 px-4 py-2 text-sm font-bold text-elq-orange disabled:cursor-not-allowed disabled:opacity-50"
        >
          {buttonLabel}
        </button>
      </div>

      <div className="space-y-3">
        {hints.nationality && (
          <HintPill label="Nationality">
            {hints.countryCode && (
              <span aria-hidden="true">{countryCodeToFlagEmoji(hints.countryCode)}</span>
            )}
            <span>{hints.nationality}</span>
          </HintPill>
        )}
        {hints.position && (
          <HintPill label="Position">
            <span>{hints.position}</span>
          </HintPill>
        )}
        {hints.skeleton && <MaskedNameHint hints={hints} />}
      </div>

      {error && <div className="mt-3 text-sm font-semibold text-red-600">{error}</div>}
    </section>
  );
}

function HintPill({ label, children }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-elq-bg px-3 py-2 text-sm">
      <span className="font-bold text-elq-muted">{label}:</span>
      <span className="flex items-center gap-1 font-semibold text-elq-dark">{children}</span>
    </div>
  );
}

function MaskedNameHint({ hints }) {
  const maskedText = maskedNameText(hints);
  return (
    <div>
      <div className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-elq-muted">
        Name skeleton
      </div>
      <div
        data-testid="career-hint-masked-name"
        aria-label={maskedText}
        className="flex flex-wrap gap-1 rounded-xl bg-elq-bg px-3 py-2 font-display text-2xl tracking-[0.18em] text-elq-dark"
      >
        {hints.skeleton.map((token) => (
          <span key={token.index} className={token.kind === "space" ? "w-3" : ""}>
            {maskedNameToken(token, hints)}
          </span>
        ))}
      </div>
    </div>
  );
}

function maskedNameText(hints) {
  return hints.skeleton
    .map((token) => maskedNameToken(token, hints))
    .join("");
}

function maskedNameToken(token, hints) {
  if (token.kind === "hidden_letter") {
    return hints.revealedPositions[token.index]?.toUpperCase() || "_";
  }
  return token.value || "";
}

function countryCodeToFlagEmoji(countryCode) {
  if (!/^[A-Za-z]{2}$/.test(countryCode || "")) return "";
  return [...countryCode.toUpperCase()]
    .map((character) => 127397 + character.charCodeAt(0))
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join("");
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

function CareerGuessBox({ onGuess, disabled, roundKey }) {
  const [query, setQuery] = useState("");
  const [players, setPlayers] = useState([]);
  const [prevRoundKey, setPrevRoundKey] = useState(roundKey);

  if (roundKey !== prevRoundKey) {
    // Reset the in-progress guess and autocomplete results whenever the active
    // round changes (opponent answered first, per-round timer expiry/auto-skip,
    // or mutual no-answer skip) so the next round opens with an empty box.
    setPrevRoundKey(roundKey);
    setQuery("");
    setPlayers([]);
  }

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!query || disabled) {
        setPlayers([]);
        return;
      }
      try {
        const result = await autocompleteCareerPlayer(query);
        if (!cancelled) {
          setPlayers(result.players || []);
        }
      } catch {
        if (!cancelled) {
          setPlayers([]);
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
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
