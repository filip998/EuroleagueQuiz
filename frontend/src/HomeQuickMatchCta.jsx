import { Link } from "react-router-dom";

const BOLT_ICON = (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
  </svg>
);

/**
 * Reusable home-card call-to-action that jumps straight into a game's online
 * Quick Match. Game-agnostic: pass the setup route in `to` (the setup screen is
 * responsible for defaulting to Quick Match) and an optional `label`. Rendered as
 * its own `<Link>` so it can sit beside a card's main link without nesting
 * anchors.
 */
export default function HomeQuickMatchCta({ to, label = "Quick Match" }) {
  return (
    <Link
      to={to}
      data-testid="home-quick-match-cta"
      onClick={(e) => e.stopPropagation()}
      className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-elq-orange px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-elq-orange-dark"
    >
      {BOLT_ICON}
      {label}
    </Link>
  );
}
