import { Link } from "react-router-dom";

const BOLT_ICON = (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
  </svg>
);

const PLAY_ICON = (
  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
    <path d="M8 5v14l11-7z" />
  </svg>
);

/**
 * Shared persistent home-card call-to-action button. Rendered as its own `<Link>`
 * so it can sit beside a card's main link without nesting anchors. Game-agnostic:
 * pass the destination route in `to`, plus a `label`, optional `icon`, and a
 * `testid`. The CTA fill is the `--color-elq-cta` token (the accessible darker
 * orange under the refined variant) and is the single source of truth for every
 * home-card CTA so the grid stays uniform.
 */
export function HomeCardCta({ to, label, icon = null, testid }) {
  return (
    <Link
      to={to}
      data-testid={testid}
      onClick={(e) => e.stopPropagation()}
      className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-elq-cta px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-elq-cta-dark"
    >
      {icon}
      {label}
    </Link>
  );
}

/**
 * Home-card CTA that jumps straight into a game's online Quick Match. Pass the
 * setup route in `to` (the setup screen is responsible for defaulting to Quick
 * Match) and an optional `label`.
 */
export default function HomeQuickMatchCta({ to, label = "Quick Match" }) {
  return <HomeCardCta to={to} label={label} icon={BOLT_ICON} testid="home-quick-match-cta" />;
}

/**
 * Home-card CTA for single-player games (e.g. Higher or Lower) that jump straight
 * into play. Mirrors the Quick Match button's slot/style with a Play affordance so
 * every home card has the same always-visible primary action.
 */
export function HomePlayCta({ to, label = "Play" }) {
  return <HomeCardCta to={to} label={label} icon={PLAY_ICON} testid="home-play-cta" />;
}
