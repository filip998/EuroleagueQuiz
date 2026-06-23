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

const PRIMARY_CLASS =
  "mt-4 inline-flex items-center gap-1.5 rounded-lg bg-elq-cta px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-elq-cta-dark";

// Low-emphasis variant: an accent-coloured text link (no fill) so a card keeps a
// visible call-to-action without competing with the page's single filled primary.
const QUIET_CLASS =
  "mt-4 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-elq-cta transition-colors hover:text-elq-cta-dark";

/**
 * Shared persistent home-card call-to-action link. Rendered as its own `<Link>` so
 * it can sit beside a card's main link without nesting anchors. Game-agnostic: pass
 * the destination route in `to`, plus a `label`, optional `icon`, and a `testid`.
 *
 * `emphasis` is the single knob for visual hierarchy (added rather than forking
 * per-card styles):
 *   - `"primary"` (default) — a solid `bg-elq-cta` filled button. Used by the
 *     flagship card and preserved verbatim for the classic home variant.
 *   - `"quiet"` — a calm accent-coloured text link with a trailing arrow and no
 *     leading icon. Used by the Refined home's mini cards so only the flagship keeps
 *     a filled primary.
 *
 * The CTA colour is the `--color-elq-cta` token (the accessible darker orange under
 * the refined variant), keeping every home-card CTA on one source of truth.
 */
export function HomeCardCta({ to, label, icon = null, testid, emphasis = "primary" }) {
  const quiet = emphasis === "quiet";
  return (
    <Link
      to={to}
      data-testid={testid}
      onClick={(e) => e.stopPropagation()}
      className={quiet ? QUIET_CLASS : PRIMARY_CLASS}
    >
      {quiet ? null : icon}
      {label}
      {quiet ? <span aria-hidden="true">→</span> : null}
    </Link>
  );
}

/**
 * Home-card CTA. With the default `primary` emphasis it is a filled button that jumps
 * into a game's online Quick Match (pass the setup route in `to`; the setup screen is
 * responsible for defaulting to Quick Match). With `emphasis="quiet"` and a calm label
 * (e.g. "Play") it becomes a low-emphasis link — used by the Refined mini cards, which
 * point at the plain setup route so the calm default door opens on the game's Solo
 * default (Quick Match stays one tap away inside setup).
 */
export default function HomeQuickMatchCta({ to, label = "Quick Match", emphasis }) {
  return (
    <HomeCardCta to={to} label={label} icon={BOLT_ICON} testid="home-quick-match-cta" emphasis={emphasis} />
  );
}

/**
 * Home-card CTA for single-player games (e.g. Higher or Lower) that jump straight into
 * play. Mirrors the Quick Match button's slot/style with a Play affordance. Accepts the
 * same `emphasis` knob so the Refined mini cards can render it as a low-emphasis link.
 */
export function HomePlayCta({ to, label = "Play", emphasis }) {
  return <HomeCardCta to={to} label={label} icon={PLAY_ICON} testid="home-play-cta" emphasis={emphasis} />;
}
