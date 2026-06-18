/**
 * BoardHeaderNav
 * Shared, consistent in-game header navigation control used by every game board.
 * Renders a single left-aligned "Home" affordance (back arrow + label) that
 * returns the player to the app home screen, replacing the previous mix of
 * "New Game" / "← Home" / logo-only treatments across boards.
 */
export default function BoardHeaderNav({ onHome, className = "" }) {
  return (
    <button
      type="button"
      onClick={onHome}
      aria-label="Back to home"
      className={`inline-flex items-center gap-1.5 text-sm text-elq-muted hover:text-elq-orange transition-colors ${className}`}
    >
      <svg
        className="w-4 h-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
      </svg>
      Home
    </button>
  );
}
