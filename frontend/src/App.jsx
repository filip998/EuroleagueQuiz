import { useState } from "react";
import GameSetup from "./GameSetup";
import GameBoard from "./GameBoard";
import RosterGuessSetup from "./RosterGuessSetup";
import RosterGuessBoard from "./RosterGuessBoard";

function App() {
  const [screen, setScreen] = useState("select");
  const [game, setGame] = useState(null);
  const [onlineInfo, setOnlineInfo] = useState(null);

  function handleGameCreated(gameResp, online) {
    setGame(gameResp);
    setOnlineInfo(online || null);
  }

  function goHome() {
    setScreen("select");
    setGame(null);
    setOnlineInfo(null);
  }

  // TicTacToe flow
  if (screen === "tictactoe") {
    if (!game) {
      return <GameSetup onGameCreated={handleGameCreated} onBack={goHome} />;
    }
    return (
      <GameBoard
        initialState={game}
        onNewGame={() => setGame(null)}
        onHome={goHome}
        onlineInfo={onlineInfo}
      />
    );
  }

  // Roster Guess flow
  if (screen === "roster") {
    if (!game) {
      return <RosterGuessSetup onGameCreated={handleGameCreated} onBack={goHome} />;
    }
    return (
      <RosterGuessBoard
        initialState={game}
        onNewGame={() => setGame(null)}
        onHome={goHome}
        onlineInfo={onlineInfo}
      />
    );
  }

  // Game selection screen
  return (
    <div className="min-h-screen flex flex-col">
      <div className="h-1 bg-gradient-to-r from-elq-orange to-elq-orange-light" />

      <div className="flex-1 flex items-center justify-center p-4 py-8">
        <div className="w-full max-w-2xl">
          {/* Header */}
          <div className="text-center mb-10 animate-fade-in-up">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-elq-orange/10 mb-5">
              <svg className="w-8 h-8 text-elq-orange" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L10 14v1c0 1.1.9 2 2 2v3.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
            </div>
            <h1 className="font-display text-5xl sm:text-7xl tracking-wide text-elq-dark leading-none">
              EUROLEAGUE
            </h1>
            <p className="font-display text-3xl sm:text-5xl text-elq-orange tracking-wider mt-1">
              QUIZ
            </p>
            <div className="w-16 h-0.5 bg-elq-orange mx-auto mt-5" />
            <p className="text-elq-muted text-sm mt-4">Choose your game</p>
          </div>

          {/* Game cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 animate-fade-in-up" style={{ animationDelay: "150ms" }}>
            {/* TicTacToe card */}
            <button
              onClick={() => setScreen("tictactoe")}
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
            </button>

            {/* Roster Guess card */}
            <button
              onClick={() => setScreen("roster")}
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
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
