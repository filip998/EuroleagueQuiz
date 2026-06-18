/**
 * OnlineScoreboard
 * Shared, consistent in-game scoreboard/header for online two-player matches,
 * used by every online board (TicTacToe, Career Quiz, Photo Quiz, Guess the List Race)
 * so player names, scores, round/target, timer, and the colored "You are X"
 * self-indicator look and behave the same across games.
 *
 * Props:
 * - ariaLabel:       string label for the scoreboard <section role="group">.
 * - title:           optional heading shown above the round/target pills
 *                    (e.g. "ONLINE RACE"); omitted when null.
 * - players:         [{ name, score, subline?, active? }, { ... }] (index 0 = P1).
 * - youPlayerNumber: 1 | 2 | null — renders a seat-colored "You are <name>" pill
 *                    only for a valid seat (so local/solo render no pill).
 * - roundNumber:     current round (renders a "Round N" pill; "Round -" when null).
 * - targetWins:      first-to target (renders a "First to N" pill when present).
 * - timer:           { seconds, critical } | null — center countdown beneath "VS".
 * - statusText:      string | null — center status line (e.g. turn / winner text).
 */

// Static per-seat class maps. Tailwind must see complete class strings, so never
// build these dynamically (e.g. `bg-elq-player${n}`) or the colors get purged.
const SEAT_STYLES = {
  1: {
    bar: "left-0 bg-elq-player1",
    panel: "border-elq-player1/25 bg-elq-player1-bg/70",
    score: "text-elq-player1",
    pill: "border-elq-player1/25 bg-elq-player1-bg",
    dot: "bg-elq-player1",
    ring: "ring-2 ring-elq-player1/50",
    label: "Player 1",
  },
  2: {
    bar: "right-0 bg-elq-player2",
    panel: "border-elq-player2/25 bg-elq-player2-bg/70",
    score: "text-elq-player2",
    pill: "border-elq-player2/25 bg-elq-player2-bg",
    dot: "bg-elq-player2",
    ring: "ring-2 ring-elq-player2/50",
    label: "Player 2",
  },
};

function ScoreboardPlayerPanel({ seat, player, align = "left" }) {
  const styles = SEAT_STYLES[seat];
  const { name, score, subline, active } = player || {};

  return (
    <div
      aria-label={`${name} score ${score}`}
      className={`relative overflow-hidden rounded-2xl border p-4 ${styles.panel} ${
        active ? styles.ring : ""
      }`}
    >
      <div className={`absolute inset-y-0 w-1.5 ${styles.bar}`} />
      <div
        className={`flex items-end justify-between gap-3 ${
          align === "right" ? "sm:flex-row-reverse sm:text-right" : ""
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.22em] text-elq-dark">
            <span>{styles.label}</span>
            {active && <span className={`h-1.5 w-1.5 rounded-full ${styles.dot} animate-pulse`} />}
          </div>
          <div className="mt-1 truncate text-base font-bold text-elq-dark sm:text-lg">{name}</div>
          {subline && <div className="mt-0.5 text-xs font-medium text-elq-muted">{subline}</div>}
        </div>
        <div className={`font-display text-5xl font-bold leading-none sm:text-6xl ${styles.score}`}>
          {score}
        </div>
      </div>
    </div>
  );
}

function ScoreboardCenter({ timer, statusText }) {
  return (
    <div className="flex flex-row items-center justify-center gap-2 sm:flex-col sm:gap-1">
      <div className="rounded-full border border-elq-border bg-elq-bg px-3 py-1 font-display text-xl tracking-wide text-elq-dark">
        VS
      </div>
      {timer && timer.seconds != null && (
        <div
          role="timer"
          aria-label={`${timer.seconds} seconds left`}
          className={`font-mono text-2xl font-bold tabular-nums sm:text-3xl ${
            timer.critical ? "animate-timer-critical" : "text-elq-dark"
          }`}
        >
          {timer.seconds}
          <span className="ml-0.5 text-sm font-normal text-elq-muted">s</span>
        </div>
      )}
      {statusText && (
        <div className="text-center text-xs font-medium text-elq-muted">{statusText}</div>
      )}
    </div>
  );
}

export default function OnlineScoreboard({
  ariaLabel = "Online match scoreboard",
  title = null,
  players = [],
  youPlayerNumber = null,
  roundNumber = null,
  targetWins = null,
  timer = null,
  statusText = null,
}) {
  const validSeat = youPlayerNumber === 1 || youPlayerNumber === 2;
  const youStyles = validSeat ? SEAT_STYLES[youPlayerNumber] : null;
  const youName = validSeat ? players[youPlayerNumber - 1]?.name : null;

  return (
    <section
      role="group"
      aria-label={ariaLabel}
      className="mb-6 overflow-hidden rounded-3xl border border-elq-border bg-white shadow-sm animate-fade-in-up"
    >
      <div className="h-1.5 bg-gradient-to-r from-elq-player1 via-elq-orange to-elq-player2" />
      <div className="p-4 sm:p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            {title && (
              <div className="font-display text-2xl tracking-wide text-elq-dark">{title}</div>
            )}
            <div
              className={`flex flex-wrap gap-2 text-xs font-bold uppercase tracking-[0.16em] text-elq-dark ${
                title ? "mt-2" : ""
              }`}
            >
              <span className="rounded-full bg-elq-bg px-2 py-0.5">
                {roundNumber != null ? `Round ${roundNumber}` : "Round -"}
              </span>
              {targetWins != null && (
                <span className="rounded-full border border-elq-orange/30 bg-elq-orange/10 px-2 py-0.5">
                  First to {targetWins}
                </span>
              )}
            </div>
          </div>
          {youStyles && youName != null && (
            <div
              className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold text-elq-dark ${youStyles.pill}`}
            >
              <span className={`h-2 w-2 rounded-full ${youStyles.dot}`} />
              <span>You are {youName}</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-[1fr_auto_1fr] sm:gap-4">
          <ScoreboardPlayerPanel seat={1} player={players[0]} />
          <ScoreboardCenter timer={timer} statusText={statusText} />
          <ScoreboardPlayerPanel seat={2} player={players[1]} align="right" />
        </div>
      </div>
    </section>
  );
}
