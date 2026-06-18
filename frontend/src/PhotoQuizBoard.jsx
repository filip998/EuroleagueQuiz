import { useEffect, useState } from "react";
import {
  autocompletePhotoPlayer,
  cancelPhotoQuickMatch,
  connectPhotoRealtime,
  createPhotoSoloRound,
  getPhotoGame,
  offerPhotoNoAnswer,
  revealPhotoSoloAnswer,
  respondPhotoNoAnswer,
  submitPhotoGuess,
  submitPhotoSoloGuess,
} from "./api";
import { REALTIME_CLIENT_ACTIONS } from "./realtimeSchema";
import { useOnlineGameRealtime } from "./useOnlineGameRealtime";
import BoardHeaderNav from "./BoardHeaderNav";
import OnlineScoreboard from "./OnlineScoreboard";
import WaitingLobby from "./WaitingLobby";
import QuickMatchSearchingLobby from "./QuickMatchSearchingLobby";
import { buildInviteUrl } from "./inviteLink";
import { clearOnlineInfo } from "./onlineRecovery";
import { forgetQuickMatchSeat } from "./quickMatchSeats";
import {
  PHOTO_QUICK_MATCH_ROUND_SECONDS,
  photoPresetLabel,
  photoSeatKey,
  usePhotoQuickMatchPools,
} from "./photoQuickMatch";
import {
  getRevealCountdownRemaining,
  shouldRevealCompletedRound,
} from "./photoQuizUtils";

const PHOTO_FEEDBACK_MESSAGES = {
  correct: "Correct!",
  soloWrong: "Not this player. Keep guessing.",
  multiplayerWrong: "Wrong guess.",
  noAnswerOfferSent: "No-answer offer sent.",
  realtimeUnavailable: "Realtime connection unavailable. Reconnecting...",
};
const PHOTO_MULTIPLAYER_SUCCESS_RESULTS = new Set(["round_won", "match_won"]);
const NO_ANSWER_OFFER_SENT_MESSAGE = PHOTO_FEEDBACK_MESSAGES.noAnswerOfferSent;
const PHOTO_FEEDBACK_TONES = {
  [PHOTO_FEEDBACK_MESSAGES.correct]: "success",
  [PHOTO_FEEDBACK_MESSAGES.soloWrong]: "error",
  [PHOTO_FEEDBACK_MESSAGES.multiplayerWrong]: "error",
  [PHOTO_FEEDBACK_MESSAGES.noAnswerOfferSent]: "neutral",
};
const PHOTO_FEEDBACK_STYLES = {
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

export default function PhotoQuizBoard({ initialState, soloInitialRound, onlineInfo, onNewGame, onHome }) {
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
  const [cancelling, setCancelling] = useState(false);
  const [roundTimerAnchor, setRoundTimerAnchor] = useState(null);
  const [lastResult, setLastResult] = useState(null);

  const solo = Boolean(soloRound);
  const isOnline = !solo && Boolean(onlineInfo);
  const playerNumber = onlineInfo?.playerNumber || 1;
  const imageUrl = solo ? soloRound?.image_url : game?.current_round?.image_url;
  const currentRoundNumber = getPhotoGameRoundNumber(game);
  const roundKey = solo ? soloRound?.round_token : currentRoundNumber;
  const revealNextRoundStartsAt = completedRound?.next_round_starts_at
    || game?.latest_completed_round?.next_round_starts_at
    || null;
  const revealCountdownRemaining = getRevealCountdownRemaining(revealNextRoundStartsAt, nowMs);
  const roundLocked = revealCountdownRemaining > 0;
  const sharedWrongGuesses = solo ? [] : game?.current_round?.wrong_guesses || [];
  const offerVersion = game?.pending_no_answer_offer_version;
  // Public Quick Match keeps a server-owned timer fallback, but it also supports
  // the same mutual no-answer offer/accept flow as friend games.
  const isPublicQuickMatch = !solo && Boolean(game?.is_public) && Boolean(game?.preset);
  const canRespondNoAnswer = (
    !solo
    && game?.pending_no_answer_to === playerNumber
    && Number.isInteger(offerVersion)
    && offerVersion > 0
  );

  // Per-round countdown affordance for public Quick Match. The realtime layer
  // does not push a deadline, so we anchor a fresh 10s window each time a round
  // becomes active and unlocked. It is display-only: it never disables guessing
  // or posts on expiry — the server owns the authoritative timer and broadcasts
  // the auto-skip, which the board reflects through the normal reveal flow.
  const timerEligible = isPublicQuickMatch && game?.status === "active" && !roundLocked;
  const showRoundTimer = (
    timerEligible
    && roundTimerAnchor != null
    && roundTimerAnchor.round === currentRoundNumber
  );
  const timerRemaining = showRoundTimer
    ? Math.min(
        PHOTO_QUICK_MATCH_ROUND_SECONDS,
        Math.max(0, Math.ceil((roundTimerAnchor.deadlineMs - nowMs) / 1000))
      )
    : null;

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

  /* These mirror CareerQuizBoard's proven state-sync effects: they reconcile
     React state with inbound realtime/poll game updates. */
  useEffect(() => {
    const latestRound = game?.latest_completed_round;
    if (!shouldRevealCompletedRound(latestRound, lastRevealedRoundNumber)) return;
    setCompletedRound(latestRound);
    setLastRevealedRoundNumber(latestRound.round_number);
  }, [game?.latest_completed_round, lastRevealedRoundNumber]);

  useEffect(() => {
    if (!timerEligible) {
      if (roundTimerAnchor !== null) setRoundTimerAnchor(null);
      return;
    }
    if (roundTimerAnchor?.round !== currentRoundNumber) {
      setRoundTimerAnchor({
        round: currentRoundNumber,
        deadlineMs: Date.now() + PHOTO_QUICK_MATCH_ROUND_SECONDS * 1000,
      });
    }
  }, [timerEligible, currentRoundNumber, roundTimerAnchor]);

  useEffect(() => {
    if (message !== NO_ANSWER_OFFER_SENT_MESSAGE || solo) return;

    const offerStillPendingFromPlayer = (
      game?.pending_no_answer_from === playerNumber
      && game?.pending_no_answer_to != null
    );
    const activeRoundNumber = getPhotoGameRoundNumber(game);
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

    if (!result.result) {
      setMessage((currentMessage) => (
        currentMessage === NO_ANSWER_OFFER_SENT_MESSAGE ? currentMessage : ""
      ));
      return;
    }
    if (result.result === "no_answer_offered") {
      if (result.state.pending_no_answer_from === playerNumber) {
        setNoAnswerOfferMessageRoundNumber(
          getPhotoGameRoundNumber(result.state) ?? currentRoundNumber
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

    const nextMessage = getPhotoMultiplayerGuessMessage(result.result);
    if (nextMessage) {
      if (shouldShowPhotoMultiplayerFeedback(result, playerNumber)) {
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
    if (isPhotoActionSyncConflict({ message: errorMessage })) {
      await resyncPhotoGame();
      return;
    }
    setMessage(errorMessage || PHOTO_FEEDBACK_MESSAGES.realtimeUnavailable);
  }

  const realtime = useOnlineGameRealtime({
    enabled: isOnline,
    gameId: game?.id,
    gameStatus: game?.status,
    playerNumber,
    connect: connectPhotoRealtime,
    fetchState: getPhotoGame,
    onState: handleRealtimeState,
    onError: handleRealtimeError,
  });

  async function nextSoloRound() {
    const next = await createPhotoSoloRound(recentIds);
    setSoloRound(next);
    setAnswer(null);
    setMessage("");
    setNoAnswerOfferMessageRoundNumber(null);
  }

  async function handleGuess(player) {
    setMessage("");
    setNoAnswerOfferMessageRoundNumber(null);
    if (solo) {
      const result = await submitPhotoSoloGuess(soloRound.round_token, player.id);
      if (result.correct) {
        setAnswer(result.answer);
        setRecentIds((ids) => [...ids.slice(-19), result.answer.id]);
        setMessage(PHOTO_FEEDBACK_MESSAGES.correct);
      } else {
        setMessage(PHOTO_FEEDBACK_MESSAGES.soloWrong);
      }
      return;
    }
    try {
      if (isOnline) {
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.GUESS, {
          player_id: player.id,
          round_number: currentRoundNumber,
        })) {
          setMessage(PHOTO_FEEDBACK_MESSAGES.realtimeUnavailable);
        }
        return;
      }

      const result = await submitPhotoGuess(game.id, playerNumber, player.id, currentRoundNumber);
      handleRealtimeState(result);
    } catch (error) {
      if (isPhotoActionSyncConflict(error)) {
        await resyncPhotoGame();
        return;
      }
      throw error;
    }
  }

  async function revealSolo() {
    const result = await revealPhotoSoloAnswer(soloRound.round_token);
    setAnswer(result.answer);
    setRecentIds((ids) => [...ids.slice(-19), result.answer.id]);
  }

  async function offerNoAnswer() {
    try {
      if (isOnline) {
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.OFFER_NO_ANSWER, {
          round_number: currentRoundNumber,
        })) {
          setMessage(PHOTO_FEEDBACK_MESSAGES.realtimeUnavailable);
        }
        return;
      }

      const result = await offerPhotoNoAnswer(game.id, playerNumber, currentRoundNumber);
      handleRealtimeState(result);
    } catch (error) {
      if (isPhotoActionSyncConflict(error)) {
        await resyncPhotoGame();
        return;
      }
      throw error;
    }
  }

  async function respondNoAnswer(accept) {
    // Re-read the offer version at click time; a stale/missing version means the
    // offer was already resolved elsewhere, so silently resync instead of POSTing
    // an int the backend would reject.
    const version = game?.pending_no_answer_offer_version;
    if (!Number.isInteger(version) || version <= 0) {
      await resyncPhotoGame();
      return;
    }
    try {
      if (isOnline) {
        if (!realtime.sendAction(REALTIME_CLIENT_ACTIONS.RESPOND_NO_ANSWER, {
          accept,
          round_number: currentRoundNumber,
          no_answer_offer_version: version,
        })) {
          setMessage(PHOTO_FEEDBACK_MESSAGES.realtimeUnavailable);
        }
        return;
      }

      const result = await respondPhotoNoAnswer(
        game.id,
        playerNumber,
        accept,
        currentRoundNumber,
        version
      );
      handleRealtimeState(result);
    } catch (error) {
      if (isPhotoActionSyncConflict(error)) {
        await resyncPhotoGame();
        return;
      }
      throw error;
    }
  }

  async function resyncPhotoGame() {
    setMessage("");
    setNoAnswerOfferMessageRoundNumber(null);
    if (!game?.id) return;
    try {
      setGame(await getPhotoGame(game.id));
    } catch {
      // Regular polling will retry transient refresh failures.
    }
  }

  async function handleQuickCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelPhotoQuickMatch({ preset: game.preset, game_id: game.id });
      // The backend deletes the waiting row, freeing its id for SQLite to reuse.
      // Drop this game's recovery data so a later game with the same id can't
      // recover the stale online seat and connect as the wrong player.
      clearOnlineInfo(game.id);
      forgetQuickMatchSeat(photoSeatKey(game.id));
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
          usePools={usePhotoQuickMatchPools}
          getPresetLabel={photoPresetLabel}
        />
      );
    }
    return (
      <WaitingLobby
        joinCode={game.join_code}
        inviteUrl={buildInviteUrl(game.join_code, "/photo")}
        onCancel={onNewGame}
      />
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
          {lastResult === "opponent_left" && (
            <p className="mb-3 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
              Your opponent left the game.
            </p>
          )}
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
            <h1 className="font-display text-4xl text-elq-dark">PHOTO QUIZ</h1>
            <p className="text-sm text-elq-muted">Name the EuroLeague player in the photo.</p>
          </div>
        </div>

        {!solo && (
          <PhotoMultiplayerScoreboard
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
          <div>
            <PhotoClue key={`${roundKey ?? "none"}|${imageUrl ?? "none"}`} imageUrl={imageUrl} />
          </div>

          <div>
            {showRoundTimer && (
              <div
                data-testid="photo-round-timer"
                className="mb-3 inline-flex items-center gap-2 rounded-full border border-elq-border bg-elq-bg px-3 py-1 text-sm font-semibold text-elq-text"
              >
                <span
                  className={`w-2 h-2 rounded-full animate-pulse ${
                    timerRemaining > 0 ? "bg-emerald-500" : "bg-elq-warning"
                  }`}
                />
                {timerRemaining > 0 ? `${timerRemaining}s left` : "Time's up — skipping…"}
              </div>
            )}

            <PhotoGuessBox
              onGuess={handleGuess}
              disabled={Boolean(answer) || roundLocked}
              roundKey={roundKey}
            />

            <PhotoFeedbackMessage message={message} />

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
                  Next photo
                </button>
              </div>
            ) : (
              <div className="mt-6 flex flex-wrap gap-3">
                {solo && (
                  <button onClick={revealSolo} className="px-5 py-2 rounded-xl border border-elq-border text-elq-text">
                    Reveal answer
                  </button>
                )}
                {!solo && canRespondNoAnswer && (
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

function getPhotoMultiplayerGuessMessage(result) {
  if (result === "incorrect") return PHOTO_FEEDBACK_MESSAGES.multiplayerWrong;
  if (PHOTO_MULTIPLAYER_SUCCESS_RESULTS.has(result)) return PHOTO_FEEDBACK_MESSAGES.correct;
  return "";
}

function shouldShowPhotoMultiplayerFeedback(message, playerNumber) {
  if (message.result === "incorrect") {
    const wrongGuesses = message.state?.current_round?.wrong_guesses;
    if (!Array.isArray(wrongGuesses) || wrongGuesses.length === 0) return true;
    return wrongGuesses[wrongGuesses.length - 1]?.player_number === playerNumber;
  }

  if (PHOTO_MULTIPLAYER_SUCCESS_RESULTS.has(message.result)) {
    const winnerPlayer =
      message.completedRound?.winner_player
      ?? message.state?.latest_completed_round?.winner_player;
    return winnerPlayer === playerNumber;
  }

  return true;
}

function PhotoFeedbackMessage({ message }) {
  if (!message) return null;

  const tone = PHOTO_FEEDBACK_TONES[message] || "info";
  const styles = PHOTO_FEEDBACK_STYLES[tone];

  return (
    <div
      role="status"
      data-testid="photo-feedback-message"
      className={`mt-4 flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm animate-slide-down ${styles.container}`}
    >
      <span className={`h-2 w-2 rounded-full ${styles.dot}`} />
      <span>{message}</span>
    </div>
  );
}

function PhotoMultiplayerScoreboard({ game, playerNumber, roundNumber }) {
  return (
    <OnlineScoreboard
      ariaLabel="Photo Quiz multiplayer scoreboard"
      title="ONLINE RACE"
      players={[
        { name: game?.player1_name || "Player 1", score: game?.player1_score ?? 0 },
        { name: game?.player2_name || "Player 2", score: game?.player2_score ?? 0 },
      ]}
      youPlayerNumber={playerNumber}
      roundNumber={roundNumber}
      targetWins={game?.target_wins ?? "-"}
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
      src={player.image_url}
      alt={player.name || ""}
      className="w-20 h-20 rounded-full object-cover object-top border border-elq-border shrink-0"
      onError={(e) => { e.target.style.display = "none"; }}
    />
  );
}

function PhotoClue({ imageUrl }) {
  // The parent remounts this component (via `key`) whenever the clue identity
  // changes, so the broken-image state resets per round without an effect.
  const [errored, setErrored] = useState(false);

  return (
    <div className="bg-white rounded-3xl border border-elq-border shadow-sm p-5 mb-5">
      <div
        className="relative mx-auto flex w-full max-w-sm items-center justify-center overflow-hidden rounded-2xl bg-elq-bg"
        style={{ aspectRatio: "3 / 4" }}
      >
        {!imageUrl ? (
          <PhotoCluePlaceholder testId="photo-clue-loading" label="Loading photo…" />
        ) : errored ? (
          <PhotoCluePlaceholder testId="photo-clue-fallback" label="Photo unavailable" />
        ) : (
          <img
            data-testid="photo-clue-image"
            src={imageUrl}
            alt="Mystery player"
            className="h-full w-full object-cover object-top"
            onError={() => setErrored(true)}
          />
        )}
      </div>
    </div>
  );
}

function PhotoCluePlaceholder({ label, testId }) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center justify-center gap-3 p-6 text-center text-elq-muted"
    >
      <svg className="w-20 h-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      </svg>
      <span className="text-sm font-semibold">{label}</span>
    </div>
  );
}

function getPhotoGameRoundNumber(game) {
  return game?.current_round?.round_number ?? game?.round_number ?? null;
}

function isPhotoActionSyncConflict(error) {
  const candidates = [
    error?.message,
    error?.detail,
    error?.payload?.message,
    error?.payload?.code,
  ];
  if (candidates.some((code) => code === "round_locked" || code === "round_stale")) {
    return true;
  }
  // A stale/duplicate no-answer response (offer version mismatch) self-heals by
  // resyncing rather than surfacing the backend's conflict text to the player.
  return candidates.some(
    (code) => typeof code === "string"
      && code.toLowerCase().includes("no answer offer is not pending")
  );
}

function PhotoGuessBox({ onGuess, disabled, roundKey }) {
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
        const result = await autocompletePhotoPlayer(query);
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
        <BoardHeaderNav onHome={onHome} />
      </div>
      <div className="flex-1 flex items-center justify-center p-4 pt-0">
        {children}
      </div>
    </div>
  );
}
