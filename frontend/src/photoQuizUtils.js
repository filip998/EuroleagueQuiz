export const PHOTO_REVEAL_COUNTDOWN_SECONDS = 3;

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
    PHOTO_REVEAL_COUNTDOWN_SECONDS,
    Math.max(0, Math.ceil((startsAtMs - nowMs) / 1000))
  );
}
