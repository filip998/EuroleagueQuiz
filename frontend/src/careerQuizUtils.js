export const CAREER_REVEAL_COUNTDOWN_SECONDS = 3;

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
