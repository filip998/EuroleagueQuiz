import { useState } from "react";
import { createCareerGame, createCareerSoloRound, joinCareerGame } from "./api";
import { getNickname, setNickname, NICKNAME_MAX_LENGTH } from "./identity";
import GameSetupShell from "./GameSetupShell";
import GameModeSelector from "./GameModeSelector";

const HEADER_ICON = (
  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m5-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </svg>
);

export default function CareerQuizSetup({ onSoloRound, onGameCreated, onGameJoined, onBack }) {
  const [mode, setMode] = useState("solo");
  const [sub, setSub] = useState("create");
  const [playerName, setPlayerName] = useState(() => getNickname());
  const [joinCode, setJoinCode] = useState("");
  const [targetWins, setTargetWins] = useState(3);
  const [wrongGuessVisibility, setWrongGuessVisibility] = useState("private");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isOnline = mode === "online";
  const isJoin = isOnline && sub === "join";

  // The name field only renders for online play, where it is the shared
  // nickname, so persist every edit.
  function handlePlayerNameChange(value) {
    setPlayerName(value);
    setNickname(value);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    const code = joinCode.trim().toUpperCase();
    if (isJoin && code.length !== 6) return;
    setLoading(true);
    try {
      if (mode === "solo") {
        onSoloRound(await createCareerSoloRound([]));
      } else if (isJoin) {
        const state = careerGameStateFromResponse(
          await joinCareerGame(code, playerName || "Player 2")
        );
        onGameJoined(state, { playerNumber: 2, isOnline: true });
      } else {
        const state = careerGameStateFromResponse(
          await createCareerGame({
            target_wins: targetWins,
            wrong_guess_visibility: wrongGuessVisibility,
            player1_name: playerName || "Player 1",
          })
        );
        onGameCreated(state, { playerNumber: 1, isOnline: true });
      }
    } catch (err) {
      setError(err.message || "Could not start Career Quiz");
    } finally {
      setLoading(false);
    }
  }

  const submitDisabled = loading || (isJoin && joinCode.trim().length !== 6);
  const ctaLabel = !isOnline ? "Start Game" : isJoin ? "Join Game" : "Create Online Game";

  return (
    <GameSetupShell
      accent="amber"
      icon={HEADER_ICON}
      title="CAREER QUIZ"
      tagline="Guess the player from his Wikipedia career timeline."
      onHome={onBack}
      error={error || null}
    >
      <form onSubmit={handleSubmit}>
        <GameModeSelector
          modes={["solo", "online"]}
          mode={mode}
          onModeChange={setMode}
          sub={sub}
          onSubChange={setSub}
        />

        {isOnline && (
          <>
            <div className="border-t border-elq-border mb-6" />

            {isJoin ? (
              <div className="space-y-4 mb-8">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-2">
                    Game Code
                  </label>
                  <input
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="ABC123"
                    maxLength={6}
                    className="w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">Your Name</label>
                  <input
                    value={playerName}
                    onChange={(e) => handlePlayerNameChange(e.target.value)}
                    placeholder="Your name"
                    maxLength={NICKNAME_MAX_LENGTH}
                    className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4 mb-8">
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">Your Name</label>
                  <input
                    value={playerName}
                    onChange={(e) => handlePlayerNameChange(e.target.value)}
                    placeholder="Your name"
                    maxLength={NICKNAME_MAX_LENGTH}
                    className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-elq-text mb-1.5">First to</label>
                    <select
                      value={targetWins}
                      onChange={(e) => setTargetWins(Number(e.target.value))}
                      className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                    >
                      {[1, 3, 5, 7].map((value) => (
                        <option key={value} value={value}>{value} wins</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-elq-text mb-1.5">Wrong guesses</label>
                    <select
                      value={wrongGuessVisibility}
                      onChange={(e) => setWrongGuessVisibility(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                    >
                      <option value="private">Private</option>
                      <option value="shared">Shared</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <button
          type="submit"
          disabled={submitDisabled}
          className="w-full py-3.5 px-6 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg tracking-wide"
        >
          {loading ? (isJoin ? "Joining..." : "Starting...") : ctaLabel}
        </button>
      </form>
    </GameSetupShell>
  );
}

function careerGameStateFromResponse(response) {
  return response?.state || response?.game || response;
}
