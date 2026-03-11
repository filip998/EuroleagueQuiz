import { useState, useEffect } from "react";
import { Routes, Route, useNavigate, useParams, useLocation, Link } from "react-router-dom";
import GameSetup from "./GameSetup";
import GameBoard from "./GameBoard";
import RosterGuessSetup from "./RosterGuessSetup";
import RosterGuessBoard from "./RosterGuessBoard";
import HigherLowerSetup from "./HigherLowerSetup";
import HigherLowerBoard from "./HigherLowerBoard";
import { LogoFull } from "./Logo";
import { getGame, getRosterGame } from "./api";

// ---------------------------------------------------------------------------
// Helpers for persisting online game info across page refreshes
// ---------------------------------------------------------------------------

function saveOnlineInfo(gameId, online) {
  if (online) {
    sessionStorage.setItem(
      `elq_game_${gameId}`,
      JSON.stringify({ playerNumber: online.playerNumber, isOnline: true })
    );
  }
}

function loadOnlineInfo(gameId) {
  try {
    const stored = sessionStorage.getItem(`elq_game_${gameId}`);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

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
// ---------------------------------------------------------------------------

function HomePage() {
  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      <div className="flex-1 flex items-center justify-center p-4 py-8">
        <div className="w-full max-w-2xl">
          {/* Header */}
          <div className="text-center mb-10 animate-fade-in-up">
            <LogoFull />
            <p className="text-elq-muted text-sm mt-5">Choose your game</p>
          </div>

          {/* Game cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5 animate-fade-in-up" style={{ animationDelay: "150ms" }}>
            {/* TicTacToe card */}
            <Link
              to="/tictactoe"
              className="group bg-white rounded-2xl border-2 border-elq-border shadow-sm hover:shadow-lg hover:border-elq-orange/40 transition-all duration-300 p-6 sm:p-8 text-left hover:scale-[1.02] active:scale-[0.98]"
            >
              <div className="w-12 h-12 rounded-xl bg-elq-player1/10 flex items-center justify-center mb-4 group-hover:bg-elq-player1/20 transition-colors">
                <svg className="w-6 h-6 text-elq-player1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />
                </svg>
              </div>
              <h2 className="font-display text-2xl text-elq-dark tracking-wide mb-2">TICTACTOE</h2>
              <p className="text-sm text-elq-muted leading-relaxed">
                Claim cells on a 3×3 board by naming players who match both row and column criteria.
              </p>
              <div className="mt-4 text-xs font-semibold text-elq-orange opacity-0 group-hover:opacity-100 transition-opacity">
                PLAY →
              </div>
            </Link>

            {/* Roster Guess card */}
            <Link
              to="/roster"
              className="group bg-white rounded-2xl border-2 border-elq-border shadow-sm hover:shadow-lg hover:border-elq-orange/40 transition-all duration-300 p-6 sm:p-8 text-left hover:scale-[1.02] active:scale-[0.98]"
            >
              <div className="w-12 h-12 rounded-xl bg-elq-player2/10 flex items-center justify-center mb-4 group-hover:bg-elq-player2/20 transition-colors">
                <svg className="w-6 h-6 text-elq-player2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
                </svg>
              </div>
              <h2 className="font-display text-2xl text-elq-dark tracking-wide mb-2">ROSTER GUESS</h2>
              <p className="text-sm text-elq-muted leading-relaxed">
                Guess the full roster of a EuroLeague team from a specific season using hints.
              </p>
              <div className="mt-4 text-xs font-semibold text-elq-orange opacity-0 group-hover:opacity-100 transition-opacity">
                PLAY →
              </div>
            </Link>

            {/* Higher or Lower card */}
            <Link
              to="/higherlower"
              className="group bg-white rounded-2xl border-2 border-elq-border shadow-sm hover:shadow-lg hover:border-elq-orange/40 transition-all duration-300 p-6 sm:p-8 text-left hover:scale-[1.02] active:scale-[0.98]"
            >
              <div className="w-12 h-12 rounded-xl bg-emerald-100 flex items-center justify-center mb-4 group-hover:bg-emerald-200 transition-colors">
                <svg className="w-6 h-6 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
                </svg>
              </div>
              <h2 className="font-display text-2xl text-elq-dark tracking-wide mb-2">HIGHER OR LOWER</h2>
              <p className="text-sm text-elq-muted leading-relaxed">
                Who has the bigger stat? Guess right to build your streak. One mistake and it's over!
              </p>
              <div className="mt-4 text-xs font-semibold text-elq-orange opacity-0 group-hover:opacity-100 transition-opacity">
                PLAY →
              </div>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TicTacToe pages
// ---------------------------------------------------------------------------

function TicTacToeSetupPage() {
  const navigate = useNavigate();

  function handleGameCreated(resp, online) {
    const gameData = resp.game || resp;
    const id = gameData.id;
    saveOnlineInfo(id, online);
    navigate(`/tictactoe/${id}`);
  }

  return <GameSetup onGameCreated={handleGameCreated} onBack={() => navigate("/")} />;
}

function TicTacToeGamePage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [onlineInfo, setOnlineInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getGame(gameId)
      .then((data) => {
        setGame(data);
        setOnlineInfo(loadOnlineInfo(gameId));
      })
      .catch(() => navigate("/tictactoe", { replace: true }))
      .finally(() => setLoading(false));
  }, [gameId, navigate]);

  if (loading) return <LoadingScreen />;
  if (!game) return null;

  return (
    <GameBoard
      initialState={game}
      onNewGame={() => navigate("/tictactoe")}
      onHome={() => navigate("/")}
      onlineInfo={onlineInfo}
    />
  );
}

// ---------------------------------------------------------------------------
// Roster Guess pages
// ---------------------------------------------------------------------------

function RosterSetupPage() {
  const navigate = useNavigate();

  function handleGameCreated(resp, online) {
    const gameData = resp.game || resp;
    const id = gameData.id;
    saveOnlineInfo(id, online);
    navigate(`/roster/${id}`);
  }

  return <RosterGuessSetup onGameCreated={handleGameCreated} onBack={() => navigate("/")} />;
}

function RosterGamePage() {
  const { gameId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState(null);
  const [onlineInfo, setOnlineInfo] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRosterGame(gameId)
      .then((data) => {
        setGame(data);
        setOnlineInfo(loadOnlineInfo(gameId));
      })
      .catch(() => navigate("/roster", { replace: true }))
      .finally(() => setLoading(false));
  }, [gameId, navigate]);

  if (loading) return <LoadingScreen />;
  if (!game) return null;

  return (
    <RosterGuessBoard
      initialState={game}
      onNewGame={() => navigate("/roster")}
      onHome={() => navigate("/")}
      onlineInfo={onlineInfo}
    />
  );
}

// ---------------------------------------------------------------------------
// Higher or Lower pages (single-player only — no server-side GET, so state
// is passed via router location state and cannot survive a hard refresh)
// ---------------------------------------------------------------------------

function HigherLowerSetupPage() {
  const navigate = useNavigate();

  function handleGameCreated(resp) {
    navigate("/higherlower/play", { state: { initialState: resp } });
  }

  return <HigherLowerSetup onGameCreated={handleGameCreated} onBack={() => navigate("/")} />;
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
      onNewGame={() => navigate("/higherlower")}
      onHome={() => navigate("/")}
    />
  );
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
      <Route path="/roster" element={<RosterSetupPage />} />
      <Route path="/roster/:gameId" element={<RosterGamePage />} />
      <Route path="/higherlower" element={<HigherLowerSetupPage />} />
      <Route path="/higherlower/play" element={<HigherLowerGamePage />} />
    </Routes>
  );
}

export default App;
