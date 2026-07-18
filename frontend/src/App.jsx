import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { Routes, Route, useNavigate, useParams, useLocation, Link, Navigate } from "react-router-dom";
import GameSetup from "./GameSetup";
import GameBoard from "./GameBoard";
import GuessTheListSetup from "./GuessTheListSetup";
import GuessTheListBoard from "./GuessTheListBoard";
import GuessTheListRaceBoard from "./GuessTheListRaceBoard";
import HigherLowerSetup from "./HigherLowerSetup";
import HigherLowerBoard from "./HigherLowerBoard";
import CareerQuizSetup from "./CareerQuizSetup";
import CareerQuizBoard from "./CareerQuizBoard";
import PhotoQuizSetup from "./PhotoQuizSetup";
import PhotoQuizBoard from "./PhotoQuizBoard";
import HomeQuickMatchCta, { HomePlayCta } from "./HomeQuickMatchCta";
import { LogoFull } from "./Logo";
import { UI_VARIANT } from "./uiVariant";
import { createGame, getCareerGame, getGame, getPhotoGame, getGuessTheListGame } from "./api";
import { parseJoinCode, parseInviteMode, RACE_INVITE_MODE } from "./inviteLink";
import {
  saveOnlineInfo,
  recoverCareerOnlineInfo,
  recoverOnlineInfo,
  recoverPhotoOnlineInfo,
  recoverGuessTheListOnlineInfo,
} from "./onlineRecovery";

// Lazy-loaded so the Clerk-backed profile page (the only thing that pulls in
// `@clerk/clerk-react` via auth.jsx) is code-split out of the main bundle and,
// crucially, never imported when App is rendered in tests without a Router/Clerk
// — the /profile route is the only place that evaluates it.
const ProfileRoute = lazy(() =>
  import("./auth").then((m) => ({ default: m.ProfileRoute }))
);

// ---------------------------------------------------------------------------
// Loading screen shown while recovering game state after a page refresh
// ---------------------------------------------------------------------------

function LoadingScreen() {
  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-elq-orange/10 mb-6">
            <svg className="w-8 h-8 text-elq-orange animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <p className="text-elq-muted text-sm">Loading game…</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home — game selection
//
// Two presentations gated by the UI variant (see uiVariant.js):
//   - HomePageClassic: the original flat 5-card grid (preserved verbatim so
//     VITE_UI_VARIANT=classic restores today's look pixel-for-pixel, apart from
//     the shared accessible primary-CTA fill token; see index.css).
//   - HomePageRefined: the compact, game-first launcher used at every viewport.
// `HomePage` picks one; the `/` route renders it. The `variant` prop defaults to
// UI_VARIANT and exists so tests can render either presentation deterministically.
// ---------------------------------------------------------------------------

export function HomePageClassic() {
  return (
    <div className="elq-auth-safe-top min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      <div className="flex-1 flex items-center justify-center p-4 py-8">
        <div className="w-full max-w-6xl">
          {/* Header */}
          <div className="text-center mb-10 animate-fade-in-up">
            <LogoFull />
            <p className="text-elq-muted text-sm mt-5">Choose your game</p>
          </div>

          {/* Game cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 sm:gap-5 animate-fade-in-up" style={{ animationDelay: "150ms" }}>
            {/* TicTacToe card — main link plus a visible one-click Quick Match CTA.
                Two sibling links (never nested anchors); both land on the setup
                screen, which now defaults to Online → Quick Match. */}
            <div className="group bg-white rounded-2xl border-2 border-elq-border shadow-sm hover:shadow-lg hover:border-elq-orange/40 transition-all duration-300 p-6 sm:p-8 text-left hover:scale-[1.02] flex flex-col">
              <Link to="/tictactoe" className="block text-left flex-1">
                <div className="w-12 h-12 rounded-xl bg-elq-player1/10 flex items-center justify-center mb-4 group-hover:bg-elq-player1/20 transition-colors">
                  <svg className="w-6 h-6 text-elq-player1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />
                  </svg>
                </div>
                <h2 className="font-display text-2xl text-elq-dark tracking-wide mb-2">TICTACTOE</h2>
                <p className="text-sm text-elq-muted leading-relaxed">
                  Claim cells on a 3×3 board by naming players who match both row and column criteria.
                </p>
              </Link>
              <HomeQuickMatchCta to="/tictactoe" />
            </div>

            {/* Guess the List card */}
            <div className="group bg-white rounded-2xl border-2 border-elq-border shadow-sm hover:shadow-lg hover:border-elq-orange/40 transition-all duration-300 p-6 sm:p-8 text-left hover:scale-[1.02] flex flex-col">
              <Link to="/list" className="block text-left flex-1">
                <div className="w-12 h-12 rounded-xl bg-elq-player2/10 flex items-center justify-center mb-4 group-hover:bg-elq-player2/20 transition-colors">
                  <svg className="w-6 h-6 text-elq-player2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
                  </svg>
                </div>
                <h2 className="font-display text-2xl text-elq-dark tracking-wide mb-2">GUESS THE LIST</h2>
                <p className="text-sm text-elq-muted leading-relaxed">
                  Name a EuroLeague team&apos;s roster, the all-time stat leaders, or a single season&apos;s top performers.
                </p>
              </Link>
              <HomeQuickMatchCta to="/list?quick=1" />
            </div>

            {/* Higher or Lower card — single-player, so the persistent bottom CTA
                is a Play button (not Quick Match), keeping the grid uniform. Main
                link plus a sibling Play link (never nested anchors); both land on
                the Higher or Lower setup screen. */}
            <div className="group bg-white rounded-2xl border-2 border-elq-border shadow-sm hover:shadow-lg hover:border-elq-orange/40 transition-all duration-300 p-6 sm:p-8 text-left hover:scale-[1.02] flex flex-col">
              <Link to="/higherlower" className="block text-left flex-1">
                <div className="w-12 h-12 rounded-xl bg-emerald-100 flex items-center justify-center mb-4 group-hover:bg-emerald-200 transition-colors">
                  <svg className="w-6 h-6 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
                  </svg>
                </div>
                <h2 className="font-display text-2xl text-elq-dark tracking-wide mb-2">HIGHER OR LOWER</h2>
                <p className="text-sm text-elq-muted leading-relaxed">
                  Who has the bigger stat? Guess right to build your streak. One mistake and it's over!
                </p>
              </Link>
              <HomePlayCta to="/higherlower" />
            </div>

            {/* Career Quiz card */}
            <div className="group bg-white rounded-2xl border-2 border-elq-border shadow-sm hover:shadow-lg hover:border-elq-orange/40 transition-all duration-300 p-6 sm:p-8 text-left hover:scale-[1.02] flex flex-col">
              <Link to="/career" className="block text-left flex-1">
                <div className="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center mb-4 group-hover:bg-amber-200 transition-colors">
                  <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m5-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                  </svg>
                </div>
                <h2 className="font-display text-2xl text-elq-dark tracking-wide mb-2">CAREER QUIZ</h2>
                <p className="text-sm text-elq-muted leading-relaxed">
                  Guess the player from a professional club career timeline powered by Wikipedia.
                </p>
              </Link>
              <HomeQuickMatchCta to="/career?quick=1" />
            </div>

            {/* Photo Quiz card — main link plus a visible one-click Quick Match CTA.
                Two sibling links (never nested anchors). The main link opens setup on
                its Solo default; the CTA forces Online → Quick Match via ?quick=1. */}
            <div className="group bg-white rounded-2xl border-2 border-elq-border shadow-sm hover:shadow-lg hover:border-elq-orange/40 transition-all duration-300 p-6 sm:p-8 text-left hover:scale-[1.02] flex flex-col">
              <Link to="/photo" className="block text-left flex-1">
                <div className="w-12 h-12 rounded-xl bg-violet-100 flex items-center justify-center mb-4 group-hover:bg-violet-200 transition-colors">
                  <svg className="w-6 h-6 text-violet-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
                  </svg>
                </div>
                <h2 className="font-display text-2xl text-elq-dark tracking-wide mb-2">PHOTO QUIZ</h2>
                <p className="text-sm text-elq-muted leading-relaxed">
                  Name the EuroLeague player from his photo. Play solo or race a friend online.
                </p>
              </Link>
              <HomeQuickMatchCta to="/photo?quick=1" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Refined Light home -----------------------------------------------------

// Per-card icons reuse the same line-art the classic grid uses; they inherit the
// accent colour from the surrounding icon chip via `currentColor`.
const ICON_TTT = (
  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />
  </svg>
);

const ICON_PEOPLE = (
  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
  </svg>
);

const ICON_ARROWS = (
  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
  </svg>
);

const ICON_CLOCK = (
  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m5-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </svg>
);

const ICON_CAMERA = (
  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
  </svg>
);

function HomeGameRow({ to, title, modes, icon, iconChip, featured = false }) {
  return (
    <Link
      to={to}
      className={`home-game-row relative flex touch-manipulation items-center gap-3 overflow-hidden rounded-2xl border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-cta focus-visible:ring-offset-2 ${
        featured
          ? "min-h-[84px] border-orange-300 bg-orange-50/80 shadow-sm active:bg-orange-100"
          : "min-h-[68px] border-elq-border bg-white shadow-sm active:bg-elq-bg"
      }`}
    >
      {featured && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-elq-orange" />}
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconChip}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        {featured && (
          <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-elq-cta">
            ★ Most played
          </span>
        )}
        <span className={`block font-display leading-none tracking-wide text-elq-dark ${featured ? "text-[1.75rem]" : "text-2xl"}`}>
          {title}
        </span>
        <span className="mt-0.5 block text-xs text-elq-muted">{modes}</span>
      </span>
      {featured ? (
        <span className="flex min-h-11 shrink-0 items-center rounded-lg bg-elq-cta px-4 text-xs font-bold text-white">
          PLAY
        </span>
      ) : (
        <span aria-hidden="true" className="text-xl text-elq-muted">→</span>
      )}
    </Link>
  );
}

function HomePageRefined() {
  return (
    <div className="elq-auth-safe-top relative min-h-screen overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(110% 54% at 50% -8%, #ffffff 0%, var(--color-elq-bg) 58%, #e7ecf3 100%)",
        }}
      />

      <main className="home-launcher relative z-10 mx-auto max-w-md px-4 py-4 sm:py-8">
        <header className="flex items-center justify-between border-b border-elq-border pb-3">
          <LogoFull className="[&_img]:w-28" />
          <span className="rounded-full border border-elq-border bg-white px-3 py-1.5 text-xs font-semibold text-elq-muted">
            5 games
          </span>
        </header>

        <section className="mt-4">
          <h1 className="font-display text-4xl leading-none tracking-wide text-elq-dark">
            CHOOSE YOUR <span className="text-elq-cta">GAME</span>
          </h1>
          <p className="mt-1 text-sm text-elq-muted">Tap a game to start.</p>
        </section>

        <nav aria-label="EuroLeague quiz games" className="mt-4 flex flex-col gap-2">
          <HomeGameRow
            to="/tictactoe"
            title="TIC-TAC-TOE"
            modes="Solo · Local · Online"
            icon={ICON_TTT}
            iconChip="border border-orange-200 bg-white text-elq-cta shadow-sm"
            featured
          />
          <HomeGameRow
            to="/list"
            title="GUESS THE LIST"
            modes="Solo · Local · Online"
            icon={ICON_PEOPLE}
            iconChip="bg-red-50 text-elq-player2"
          />
          <HomeGameRow
            to="/higherlower"
            title="HIGHER OR LOWER"
            modes="Solo"
            icon={ICON_ARROWS}
            iconChip="bg-emerald-50 text-emerald-600"
          />
          <HomeGameRow
            to="/career"
            title="CAREER QUIZ"
            modes="Solo · Online"
            icon={ICON_CLOCK}
            iconChip="bg-amber-50 text-amber-600"
          />
          <HomeGameRow
            to="/photo"
            title="PHOTO QUIZ"
            modes="Solo · Online"
            icon={ICON_CAMERA}
            iconChip="bg-violet-50 text-violet-600"
          />
        </nav>

        <p className="mt-4 text-center text-xs text-elq-muted">3,000+ players · 25 seasons</p>
      </main>
    </div>
  );
}

export function HomePage({ variant = UI_VARIANT }) {
  return variant === "classic" ? <HomePageClassic /> : <HomePageRefined />;
}

// ---------------------------------------------------------------------------
// TicTacToe pages
// ---------------------------------------------------------------------------

function TicTacToeSetupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialJoinCode = parseJoinCode(location.search);
  const applyPreferences = Boolean(location.state?.replay);

  function handleGameCreated(resp, online) {
    const gameData = resp.state || resp.game || resp;
    const id = gameData.id;
    saveOnlineInfo(id, online);
    navigate(`/tictactoe/${id}`);
  }

  return (
    <GameSetup
      key={initialJoinCode || "no-invite"}
      initialJoinCode={initialJoinCode}
      applyPreferences={applyPreferences}
      onGameCreated={handleGameCreated}
      onBack={() => navigate("/")}
    />
  );
}

export function TicTacToeGamePage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [onlineInfo, setOnlineInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const replayingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    replayingRef.current = false;
    getGame(gameId)
      .then((data) => {
        if (cancelled) return;
        setGame(data);
        setOnlineInfo(recoverOnlineInfo(gameId, data));
      })
      .catch(() => {
        if (!cancelled) navigate("/tictactoe", { replace: true });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gameId, navigate]);

  async function handleNewGame() {
    // Local 1v1 and online matches return to the setup screen to reconfigure.
    // The replay flag tells the setup screen to prefill the last-used choices.
    if (game?.mode !== "single_player") {
      navigate("/tictactoe", { state: { replay: true } });
      return;
    }
    // Solo "Play Again" starts a fresh solo board with the same solo defaults and
    // drops the player straight into it, instead of returning to the setup screen
    // (which defaults to Online -> Quick Match). The ref guards against double-taps.
    if (replayingRef.current) return;
    replayingRef.current = true;
    try {
      const resp = await createGame({ mode: "single_player", timer_mode: "unlimited" });
      navigate(`/tictactoe/${resp.state.id}`);
    } catch {
      // Creating the solo board failed (rare, local insert). Fall back to setup so
      // the player can retry rather than being stuck on the finished result screen.
      // Carry the replay flag so the setup restores the player's Solo choice
      // instead of defaulting to Online -> Quick Match.
      replayingRef.current = false;
      navigate("/tictactoe", { state: { replay: true } });
    }
  }

  // Hold on the loading screen until the fetched game matches the current route
  // id. This hides the previous finished board during a solo replay and forces a
  // fresh GameBoard mount (with key) so its internal state re-initializes.
  if (loading || !game || String(game.id) !== String(gameId)) return <LoadingScreen />;

  return (
    <GameBoard
      key={game.id}
      initialState={game}
      onNewGame={handleNewGame}
      onHome={() => navigate("/")}
      onlineInfo={onlineInfo}
    />
  );
}

// ---------------------------------------------------------------------------
// Guess the List pages
// ---------------------------------------------------------------------------

function GuessTheListSetupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isQuickRace = new URLSearchParams(location.search).get("quick") === "1";
  // Quick Match wins over any invite code, so it never opens a friend join.
  const joinCode = isQuickRace ? "" : parseJoinCode(location.search);
  const isRaceJoin = Boolean(joinCode) && parseInviteMode(location.search) === RACE_INVITE_MODE;

  let initialMode = "solo";
  let initialOnlineGameType = "classic";
  if (isQuickRace) {
    initialMode = "online";
    initialOnlineGameType = "race";
  } else if (joinCode) {
    initialMode = "online";
    initialOnlineGameType = isRaceJoin ? "race" : "classic";
  }

  const setupKey = isQuickRace
    ? "race-quick"
    : joinCode
      ? `join-${initialOnlineGameType}-${joinCode}`
      : "default";
  const applyPreferences = Boolean(location.state?.replay);

  function handleGameCreated(resp, online) {
    const gameData = resp.state || resp.game || resp;
    const id = gameData.id;
    saveOnlineInfo(id, online);
    navigate(`/list/${id}`);
  }

  return (
    <GuessTheListSetup
      key={setupKey}
      initialMode={initialMode}
      initialOnlineGameType={initialOnlineGameType}
      initialJoinCode={joinCode}
      applyPreferences={applyPreferences}
      onGameCreated={handleGameCreated}
      onBack={() => navigate("/")}
    />
  );
}

function GuessTheListGamePage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [onlineInfo, setOnlineInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getGuessTheListGame(gameId)
      .then((data) => {
        setGame(data);
        setOnlineInfo(recoverGuessTheListOnlineInfo(gameId, data));
      })
      .catch(() => navigate("/list", { replace: true }))
      .finally(() => setLoading(false));
  }, [gameId, navigate]);

  if (loading) return <LoadingScreen />;
  if (!game) return null;

  return (
    game?.is_race ? (
      <GuessTheListRaceBoard
        initialState={game}
        onNewGame={() => navigate("/list", { state: { replay: true } })}
        onHome={() => navigate("/")}
        onlineInfo={onlineInfo}
      />
    ) : (
      <GuessTheListBoard
        initialState={game}
        onNewGame={() => navigate("/list", { state: { replay: true } })}
        onHome={() => navigate("/")}
        onlineInfo={onlineInfo}
      />
    )
  );
}

// ---------------------------------------------------------------------------
// Higher or Lower pages (single-player only — no server-side GET, so state
// is passed via router location state and cannot survive a hard refresh)
// ---------------------------------------------------------------------------

function HigherLowerSetupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const applyPreferences = Boolean(location.state?.replay);

  function handleGameCreated(resp) {
    navigate("/higherlower/play", { state: { initialState: resp } });
  }

  return (
    <HigherLowerSetup
      applyPreferences={applyPreferences}
      onGameCreated={handleGameCreated}
      onBack={() => navigate("/")}
    />
  );
}

function HigherLowerGamePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialState = location.state?.initialState;

  useEffect(() => {
    if (!initialState) navigate("/higherlower", { replace: true });
  }, [initialState, navigate]);

  if (!initialState) return null;

  return (
    <HigherLowerBoard
      initialState={initialState}
      onNewGame={() => navigate("/higherlower", { state: { replay: true } })}
      onHome={() => navigate("/")}
    />
  );
}

// ---------------------------------------------------------------------------
// Career Quiz pages
// ---------------------------------------------------------------------------

function CareerSetupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isQuick = new URLSearchParams(location.search).get("quick") === "1";
  // A `?join=` invite link opens Online -> Play a Friend -> Join with the code
  // prefilled. Quick Match wins over any invite code, so it never opens a join.
  const joinCode = isQuick ? "" : parseJoinCode(location.search);
  const initialMode = isQuick || joinCode ? "online" : "solo";
  const setupKey = joinCode ? `join-${joinCode}` : initialMode;
  const applyPreferences = Boolean(location.state?.replay);

  function handleSoloRound(round) {
    navigate("/career/play", { state: { soloRound: round } });
  }

  function handleGameCreated(game, online) {
    const gameData = game?.state || game?.game || game;
    saveOnlineInfo(gameData.id, online);
    navigate(`/career/${gameData.id}`);
  }

  return (
    <CareerQuizSetup
      key={setupKey}
      initialMode={initialMode}
      initialJoinCode={joinCode}
      applyPreferences={applyPreferences}
      onSoloRound={handleSoloRound}
      onGameCreated={handleGameCreated}
      onGameJoined={handleGameCreated}
      onBack={() => navigate("/")}
    />
  );
}

function CareerSoloPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const soloRound = location.state?.soloRound;

  useEffect(() => {
    if (!soloRound) navigate("/career", { replace: true });
  }, [soloRound, navigate]);

  if (!soloRound) return null;

  return (
    <CareerQuizBoard
      soloInitialRound={soloRound}
      onNewGame={() => navigate("/career", { state: { replay: true } })}
      onHome={() => navigate("/")}
    />
  );
}

function CareerGamePage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [onlineInfo, setOnlineInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCareerGame(gameId)
      .then((data) => {
        setGame(data);
        setOnlineInfo(recoverCareerOnlineInfo(gameId, data));
      })
      .catch(() => navigate("/career", { replace: true }))
      .finally(() => setLoading(false));
  }, [gameId, navigate]);

  if (loading) return <LoadingScreen />;
  if (!game) return null;

  return (
    <CareerQuizBoard
      initialState={game}
      onlineInfo={onlineInfo}
      onNewGame={() => navigate("/career", { state: { replay: true } })}
      onHome={() => navigate("/")}
    />
  );
}

// ---------------------------------------------------------------------------
// Photo Quiz pages
// ---------------------------------------------------------------------------

function PhotoSetupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  // A `?quick=1` deep link (the classic home card, or `/photo?quick=1` directly)
  // opens setup on Online, which defaults to the Quick Match pool grid. A `?join=`
  // invite link instead opens Online -> Play a Friend -> Join with the code
  // prefilled. Any plain `/photo` visit keeps PhotoQuizSetup's Solo default.
  const isQuick = new URLSearchParams(location.search).get("quick") === "1";
  // Quick Match wins over any invite code, so it never opens a friend join.
  const joinCode = isQuick ? "" : parseJoinCode(location.search);
  const initialMode = isQuick || joinCode ? "online" : "solo";
  const setupKey = joinCode ? `join-${joinCode}` : initialMode;
  const applyPreferences = Boolean(location.state?.replay);

  function handleSoloRound(round) {
    navigate("/photo/play", { state: { soloRound: round } });
  }

  function handleGameCreated(game, online) {
    const gameData = game?.state || game?.game || game;
    saveOnlineInfo(gameData.id, online);
    navigate(`/photo/${gameData.id}`);
  }

  return (
    <PhotoQuizSetup
      key={setupKey}
      initialMode={initialMode}
      initialJoinCode={joinCode}
      applyPreferences={applyPreferences}
      onSoloRound={handleSoloRound}
      onGameCreated={handleGameCreated}
      onGameJoined={handleGameCreated}
      onBack={() => navigate("/")}
    />
  );
}

function PhotoSoloPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const soloRound = location.state?.soloRound;

  useEffect(() => {
    if (!soloRound) navigate("/photo", { replace: true });
  }, [soloRound, navigate]);

  if (!soloRound) return null;

  return (
    <PhotoQuizBoard
      soloInitialRound={soloRound}
      onNewGame={() => navigate("/photo", { state: { replay: true } })}
      onHome={() => navigate("/")}
    />
  );
}

function PhotoGamePage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [onlineInfo, setOnlineInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getPhotoGame(gameId)
      .then((data) => {
        setGame(data);
        setOnlineInfo(recoverPhotoOnlineInfo(gameId, data));
      })
      .catch(() => navigate("/photo", { replace: true }))
      .finally(() => setLoading(false));
  }, [gameId, navigate]);

  if (loading) return <LoadingScreen />;
  if (!game) return null;

  return (
    <PhotoQuizBoard
      initialState={game}
      onlineInfo={onlineInfo}
      onNewGame={() => navigate("/photo", { state: { replay: true } })}
      onHome={() => navigate("/")}
    />
  );
}

function LegacyRosterRedirect() {
  const { gameId } = useParams();
  const location = useLocation();
  const target = gameId ? `/list/${gameId}` : "/list";
  return <Navigate to={`${target}${location.search}`} replace />;
}

// ---------------------------------------------------------------------------
// Root — route definitions
// ---------------------------------------------------------------------------

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/tictactoe" element={<TicTacToeSetupPage />} />
      <Route path="/tictactoe/:gameId" element={<TicTacToeGamePage />} />
      <Route path="/list" element={<GuessTheListSetupPage />} />
      <Route path="/list/:gameId" element={<GuessTheListGamePage />} />
      <Route path="/roster" element={<LegacyRosterRedirect />} />
      <Route path="/roster/:gameId" element={<LegacyRosterRedirect />} />
      <Route path="/higherlower" element={<HigherLowerSetupPage />} />
      <Route path="/higherlower/play" element={<HigherLowerGamePage />} />
      <Route path="/career" element={<CareerSetupPage />} />
      <Route path="/career/play" element={<CareerSoloPage />} />
      <Route path="/career/:gameId" element={<CareerGamePage />} />
      <Route path="/photo" element={<PhotoSetupPage />} />
      <Route path="/photo/play" element={<PhotoSoloPage />} />
      <Route path="/photo/:gameId" element={<PhotoGamePage />} />
      <Route
        path="/profile/*"
        element={
          <Suspense fallback={<LoadingScreen />}>
            <ProfileRoute />
          </Suspense>
        }
      />
    </Routes>
  );
}

export default App;
