import { useEffect, useRef, useState } from "react";
import { useListKeyboardNav } from "./useListKeyboardNav";
import {
  autocompleteCareerPlayer,
  cancelCareerQuickMatch,
  connectCareerRealtime,
  createCareerSoloRound,
  fetchCareerSoloHint,
  getCareerGame,
  offerCareerNoAnswer,
  revealCareerSoloAnswer,
  respondCareerNoAnswer,
  resignCareerGame,
  submitCareerGuess,
  submitCareerSoloGuess,
} from "./api";
import { REALTIME_CLIENT_ACTIONS } from "./realtimeSchema";
import { useOnlineGameRealtime } from "./useOnlineGameRealtime";
import { optimizeHeadshot, handleHeadshotError, HEADSHOT_WIDTHS } from "./imageUrl";
import BoardHeaderNav from "./BoardHeaderNav";
import OnlineScoreboard from "./OnlineScoreboard";
import WaitingLobby from "./WaitingLobby";
import ResignControl from "./ResignControl";
import GameResult from "./GameResult";
import { winnerDisplayName } from "./winnerName";
import QuickMatchSearchingLobby from "./QuickMatchSearchingLobby";
import { buildInviteUrl } from "./inviteLink";
import { clearOnlineInfo } from "./onlineRecovery";
import { forgetQuickMatchSeat } from "./quickMatchSeats";
import {
  CAREER_QUICK_MATCH_ROUND_SECONDS,
  careerPresetLabel,
  careerSeatKey,
  useCareerQuickMatchPools,
} from "./careerQuickMatch";
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
  const [soloScore, setSoloScore] = useState({ solved: 0, streak: 0 });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [resigning, setResigning] = useState(false);
  const [roundTimerAnchor, setRoundTimerAnchor] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const soloRoundTokenRef = useRef(soloInitialRound?.round_token || null);
  // Tracks the solo round_token whose terminal outcome (correct guess or reveal)
  // has already updated the score, so a duplicate/late response can never double
  // count or reset the Solved/Streak counter for the same round.
  const soloResolvedRoundRef = useRef(null);

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
  const isPublicQuickMatch = !solo && Boolean(game?.is_public) && Boolean(game?.preset);
  const finishedWinnerName = winnerDisplayName(game);
  const timerEligible = isPublicQuickMatch && game?.status === "active" && !roundLocked;
  const showRoundTimer = (
    timerEligible
    && roundTimerAnchor != null
    && roundTimerAnchor.round === currentRoundNumber
  );
  const timerRemaining = showRoundTimer
    ? Math.min(
        CAREER_QUICK_MATCH_ROUND_SECONDS,
        Math.max(0, Math.ceil((roundTimerAnchor.deadlineMs - nowMs) / 1000))
      )
    : null;

  useEffect(() => {
    soloRoundTokenRef.current = soloRound?.round_token || null;
  }, [soloRound?.round_token]);

  useEffect(() => {
    if (!revealNextRoundStartsAt && !showRoundTimer) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [revealNextRoundStartsAt, showRoundTimer]);

  useEffect(() => {
    if (!completedRound) return undefined;
    const timer = setTimeout(() => setCompletedRound(null), 3000);
    return () => clearTimeout(timer);
  }, [completedRound]);

  useEffect(() => {
    if (!timerEligible) {
      if (roundTimerAnchor !== null) setRoundTimerAnchor(null);
      return;
    }
    if (roundTimerAnchor?.round !== currentRoundNumber) {
      setRoundTimerAnchor({
        round: currentRoundNumber,
        deadlineMs: Date.now() + CAREER_QUICK_MATCH_ROUND_SECONDS * 1000,
      });
    }
  }, [timerEligible, currentRoundNumber, roundTimerAnchor]);

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

    if (result.result === "opponent_left") {
      setLastResult("opponent_left");
      return;
    }

    if (result.result === "resigned") {
      setLastResult("resigned");
      return;
    }

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
    soloResolvedRoundRef.current = null;
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
      const requestedRoundToken = soloRound.round_token;
      const result = await submitCareerSoloGuess(requestedRoundToken, player.id);
      // Drop a response that resolved after the player already advanced rounds.
      if (soloRoundTokenRef.current !== requestedRoundToken) return;
      if (result.correct) {
        // Score the round exactly once even if two correct responses arrive.
        if (soloResolvedRoundRef.current !== requestedRoundToken) {
          soloResolvedRoundRef.current = requestedRoundToken;
          setSoloScore((score) => ({ solved: score.solved + 1, streak: score.streak + 1 }));
          setAnswer(result.answer);
          setRecentIds((ids) => [...ids.slice(-19), result.answer.id]);
          setMessage(CAREER_FEEDBACK_MESSAGES.correct);
        }
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
    const requestedRoundToken = soloRound.round_token;
    const result = await revealCareerSoloAnswer(requestedRoundToken);
    if (soloRoundTokenRef.current !== requestedRoundToken) return;
    // Revealing without solving ends the round: keep Solved, reset the Streak,
    // and only once per round.
    if (soloResolvedRoundRef.current !== requestedRoundToken) {
      soloResolvedRoundRef.current = requestedRoundToken;
      setSoloScore((score) => ({ ...score, streak: 0 }));
      setAnswer(result.answer);
      setRecentIds((ids) => [...ids.slice(-19), result.answer.id]);
    }
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

  async function handleResign() {
    setResigning(true);
    try {
      const result = await resignCareerGame(game.id, playerNumber);
      handleRealtimeState(result);
    } catch (error) {
      setMessage(error.message || CAREER_FEEDBACK_MESSAGES.realtimeUnavailable);
    } finally {
      setResigning(false);
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

  async function handleQuickCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelCareerQuickMatch({ preset: game.preset, game_id: game.id });
      // The backend deletes the waiting row, freeing its id for SQLite to reuse.
      // Drop this game's recovery data so a later game with the same id can't
      // recover the stale online seat and connect as the wrong player.
      clearOnlineInfo(game.id);
      forgetQuickMatchSeat(careerSeatKey(game.id));
      onNewGame();
    } catch {
      // The search was likely matched a moment before cancelling (the backend
      // rejects cancelling a game that is no longer waiting). Stay on the board;
      // the realtime hook will flip to the active game.
      setCancelling(false);
    }
  }

  if (game?.status === "waiting_for_opponent") {
    if (game.is_public && game.preset) {
      return (
        <QuickMatchSearchingLobby
          preset={game.preset}
          onCancel={handleQuickCancel}
          cancelling={cancelling}
          usePools={useCareerQuickMatchPools}
          getPresetLabel={careerPresetLabel}
        />
      );
    }
    return (
      <WaitingLobby
        joinCode={game.join_code}
        inviteUrl={buildInviteUrl(game.join_code, "/career")}
        onCancel={onNewGame}
      />
    );
  }

  if (game?.status === "finished") {
    return (
      <GameResult
        title={finishedWinnerName ? `${finishedWinnerName} WINS!` : "No winner"}
        subtitle={`${game.player1_score} - ${game.player2_score}`}
        onPlayAgain={onNewGame}
        onHome={onHome}
      >
        <CompletedRoundReveal
          round={completedRound}
          countdownRemaining={revealCountdownRemaining}
        />
        {lastResult === "opponent_left" && (
          <p className="mb-3 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
            Your opponent left the game.
          </p>
        )}
        {lastResult === "resigned" && (
          <p className="mb-3 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
            {game.winner_player === playerNumber ? "Your opponent resigned." : "You resigned."}
          </p>
        )}
      </GameResult>
    );
  }

  if (solo) {
    return (
      <Shell
        onHome={onHome}
        align="top"
        headerRight={
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-elq-text">
            <span className="h-2 w-2 rounded-full bg-elq-orange" aria-hidden="true" />
            Solo
          </span>
        }
      >
        <div className="w-full max-w-6xl">
          <SoloHud
            solved={soloScore.solved}
            streak={soloScore.streak}
            hintsUsed={soloHints.usedCount}
            hintLoading={soloHintLoading}
            hintExhausted={soloHints.exhausted}
            answered={Boolean(answer)}
            onRevealHint={revealSoloHint}
            onRevealAnswer={revealSolo}
          />

          <p className="mt-2 px-1 text-xs text-elq-muted">
            Career data from Wikipedia and may be incomplete.
          </p>

          <div className="mt-4 grid gap-6 lg:grid-cols-2 lg:items-start">
            <div className="lg:max-h-[68vh] lg:overflow-y-auto">
              <Timeline timeline={timeline} />
            </div>

            <div>
              <CareerGuessBox
                onGuess={handleGuess}
                disabled={Boolean(answer)}
                roundKey={roundKey}
                bare
              />

              <SoloHintDetails hints={soloHints} error={soloHintError} />

              <CareerFeedbackMessage message={message} />

              {answer && <SoloAnswerReveal answer={answer} onNext={nextSoloRound} />}
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onHome={onHome}>
      <div className="w-full max-w-5xl">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="font-display text-4xl text-elq-dark">CAREER QUIZ</h1>
            <p className="text-sm text-elq-muted">Career data from Wikipedia and may be incomplete.</p>
          </div>
        </div>

        <CareerMultiplayerScoreboard
          game={game}
          playerNumber={playerNumber}
          roundNumber={currentRoundNumber}
          timer={
            showRoundTimer && timerRemaining != null
              ? { seconds: timerRemaining, critical: timerRemaining <= 5 }
              : null
          }
        />

        <CompletedRoundReveal
          round={completedRound}
          countdownRemaining={revealCountdownRemaining}
        />

        <div className="grid lg:grid-cols-2 gap-6 items-start">
          <div className="lg:max-h-[60vh] lg:overflow-y-auto">
            <Timeline timeline={timeline} />
          </div>

          <div>
            {showRoundTimer && timerRemaining <= 0 && (
              <div
                data-testid="career-round-timer"
                className="mb-3 inline-flex items-center gap-2 rounded-full border border-elq-border bg-elq-bg px-3 py-1 text-sm font-semibold text-elq-text"
              >
                <span className="w-2 h-2 rounded-full animate-pulse bg-elq-warning" />
                Time&apos;s up — skipping…
              </div>
            )}

            <CareerGuessBox
              onGuess={handleGuess}
              disabled={roundLocked}
              roundKey={roundKey}
            />

            <CareerFeedbackMessage message={message} />

            <SharedWrongGuesses
              guesses={sharedWrongGuesses}
              player1Name={game?.player1_name}
              player2Name={game?.player2_name}
            />

            <div className="mt-6 flex flex-wrap gap-3">
              {!isPublicQuickMatch && game?.pending_no_answer_to === playerNumber && (
                <>
                  <button
                    onClick={() => respondNoAnswer(true)}
                    disabled={roundLocked}
                    className="px-5 py-2 rounded-xl bg-elq-cta text-white font-bold disabled:opacity-50"
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
              {!isPublicQuickMatch && !game?.pending_no_answer_to && (
                <button
                  onClick={offerNoAnswer}
                  disabled={roundLocked}
                  className="px-5 py-2 rounded-xl border border-elq-border text-elq-text disabled:opacity-50"
                >
                  Nobody knows
                </button>
              )}
            </div>
          </div>
        </div>
        {isOnline && game?.status === "active" && !roundLocked && (
          <ResignControl onResign={handleResign} disabled={resigning} />
        )}
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

function SoloHud({
  solved,
  streak,
  hintsUsed,
  hintLoading,
  hintExhausted,
  answered,
  onRevealHint,
  onRevealAnswer,
}) {
  const hintButtonDisabled = answered || hintLoading || hintExhausted;
  const hintButtonLabel = hintExhausted
    ? "No more hints"
    : hintLoading ? "Loading hint..." : "Reveal a hint";

  return (
    <section
      aria-label="Career solo status"
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl border border-elq-border bg-white px-4 py-2.5 shadow-sm"
    >
      <p className="text-sm font-bold text-elq-dark sm:text-base">
        Which player had this career?
      </p>

      <div className="flex items-baseline gap-2 text-sm">
        <span className="flex items-baseline gap-1.5" role="group" aria-label={`Solved ${solved}`}>
          <span className="text-elq-text">Solved</span>
          <span className="font-bold tabular-nums text-elq-dark">{solved}</span>
        </span>
        <span aria-hidden="true" className="text-elq-border">·</span>
        <span className="flex items-baseline gap-1.5" role="group" aria-label={`Streak ${streak}`}>
          <span className="text-elq-text">Streak</span>
          <span className="font-bold tabular-nums text-elq-dark">{streak}</span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-elq-text">Hints used: {hintsUsed}</span>
        <button
          type="button"
          onClick={onRevealHint}
          disabled={hintButtonDisabled}
          className="rounded-xl border border-elq-orange/30 px-4 py-2 font-bold text-elq-cta disabled:cursor-not-allowed disabled:opacity-50"
        >
          {hintButtonLabel}
        </button>
        <button
          type="button"
          onClick={onRevealAnswer}
          disabled={answered}
          className="rounded-xl border border-elq-border px-4 py-2 font-semibold text-elq-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reveal answer
        </button>
      </div>
    </section>
  );
}

function SoloHintDetails({ hints, error }) {
  const hasContent = Boolean(hints.nationality || hints.position || hints.skeleton);
  if (!hasContent && !error) return null;

  return (
    <section
      aria-label="Solo career hints"
      data-testid="career-solo-hints"
      className="mt-4 space-y-3"
    >
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
      {error && <div className="text-sm font-semibold text-red-600">{error}</div>}
    </section>
  );
}

function SoloAnswerReveal({ answer, onNext }) {
  return (
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
      <button onClick={onNext} className="px-6 py-3 rounded-xl bg-elq-cta text-white font-bold">
        Next career
      </button>
    </div>
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

function CareerMultiplayerScoreboard({ game, playerNumber, roundNumber, timer = null }) {
  return (
    <OnlineScoreboard
      ariaLabel="Career Quiz multiplayer scoreboard"
      title="ONLINE RACE"
      players={[
        { name: game?.player1_name || "Player 1", score: game?.player1_score ?? 0 },
        { name: game?.player2_name || "Player 2", score: game?.player2_score ?? 0 },
      ]}
      youPlayerNumber={playerNumber}
      roundNumber={roundNumber}
      targetWins={game?.target_wins ?? "-"}
      timer={timer}
    />
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
      src={optimizeHeadshot(player.image_url, { width: HEADSHOT_WIDTHS.answer })}
      alt={player.name || ""}
      className="w-20 h-20 rounded-full object-cover object-top border border-elq-border shrink-0"
      onError={(e) => handleHeadshotError(e, player.image_url, (ev) => { ev.currentTarget.style.display = "none"; })}
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

function CareerGuessBox({ onGuess, disabled, roundKey, bare = false }) {
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

  const { activeIndex, activeItemRef, handleKeyDown: handleNavKeyDown } =
    useListKeyboardNav(players, selectPlayer);

  function handleKeyDown(event) {
    if (disabled) return;
    handleNavKeyDown(event);
  }

  return (
    <div className={bare ? "" : "bg-white rounded-2xl border border-elq-border p-4"}>
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
          {players.map((player, index) => (
            <button
              key={player.id}
              ref={index === activeIndex ? activeItemRef : undefined}
              aria-selected={index === activeIndex}
              onClick={() => selectPlayer(player)}
              className={`block w-full text-left px-4 py-2 hover:bg-elq-orange/5 ${
                index === activeIndex ? "bg-elq-orange/5" : ""
              }`}
            >
              {player.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell({ children, onHome, align = "center", headerRight = null }) {
  const alignClass = align === "top" ? "items-start" : "items-center";
  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
      <div className="p-4">
        {headerRight ? (
          <div className="flex items-center justify-between gap-4">
            <BoardHeaderNav onHome={onHome} />
            {headerRight}
          </div>
        ) : (
          <BoardHeaderNav onHome={onHome} />
        )}
      </div>
      <div className={`flex-1 flex ${alignClass} justify-center p-4 pt-0`}>
        {children}
      </div>
    </div>
  );
}
