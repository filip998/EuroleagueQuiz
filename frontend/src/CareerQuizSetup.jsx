import { useMemo, useRef, useState } from "react";
import {
  careerQuickMatch,
  createCareerGame,
  createCareerSoloRound,
  joinCareerGame,
} from "./api";
import { getDisplayName, setNickname } from "./identity";
import { useClerkPrefilledName } from "./identityBridge";
import { normalizeJoinCode } from "./inviteLink";
import { loadSetupPreferences, saveSetupPreferences } from "./setupPreferences";
import GameSetupShell, { SectionCaption } from "./GameSetupShell";
import GameModeSelector from "./GameModeSelector";
import NameField from "./NameField";
import QuickMatchPanel from "./QuickMatchPanel";
import {
  CAREER_QUICK_MATCH_PRESETS,
  DEFAULT_CAREER_QUICK_MATCH_PRESET,
  careerSeatKey,
  useCareerQuickMatchPools,
} from "./careerQuickMatch";
import { resolveQuickMatchSeat } from "./quickMatchSeats";

const HEADER_ICON = (
  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m5-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </svg>
);

const ONLINE_SUB_MODES = [
  ["quick", "Quick Match"],
  ["friend", "Play a Friend"],
];

const FRIEND_SUB_MODES = [
  ["create", "Create"],
  ["join", "Join"],
];

export default function CareerQuizSetup({ onSoloRound, onGameCreated, onGameJoined, onBack, initialMode = "solo", initialJoinCode = "", applyPreferences = false }) {
  const prefillCode = normalizeJoinCode(initialJoinCode);
  // A `?quick=1` deep link (initialMode==="online") or an invite code must win
  // over stored prefs, so prefs are only loaded for a plain replay.
  const hasDeepLink = initialMode === "online" || Boolean(prefillCode);
  const prefs = useMemo(
    () => (applyPreferences && !hasDeepLink ? loadSetupPreferences("career") : null),
    [applyPreferences, hasDeepLink],
  );
  const [mode, setMode] = useState(() =>
    initialMode === "online" || prefillCode ? "online" : prefs?.mode ?? "solo",
  );
  // A valid invite code lands on Online -> Play a Friend -> Join with the code
  // prefilled; otherwise Online defaults to the Quick Match pool grid.
  const [onlineSub, setOnlineSub] = useState(() =>
    prefillCode ? "friend" : prefs?.onlineSub ?? "quick",
  );
  const [friendSub, setFriendSub] = useState(() =>
    prefillCode ? "join" : prefs?.friendSub ?? "create",
  );
  const [playerName, setPlayerName] = useClerkPrefilledName(getDisplayName);
  const [joinCode, setJoinCode] = useState(prefillCode);
  const [targetWins, setTargetWins] = useState(() => prefs?.targetWins ?? 3);
  const [wrongGuessVisibility, setWrongGuessVisibility] = useState(() => prefs?.wrongGuessVisibility ?? "private");
  const [loading, setLoading] = useState(false);
  const [pendingPreset, setPendingPreset] = useState(null);
  const [error, setError] = useState("");
  const inFlightRef = useRef(false);

  const isOnline = mode === "online";
  const isQuick = isOnline && onlineSub === "quick";
  const isFriend = isOnline && onlineSub === "friend";
  const isJoin = isFriend && friendSub === "join";
  const { pools } = useCareerQuickMatchPools(isQuick);

  // The name field only renders for online play, where it is the shared
  // nickname, so persist every edit.
  function handlePlayerNameChange(value) {
    setPlayerName(value);
    setNickname(value);
  }

  async function handleQuickPick(preset) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError("");
    setLoading(true);
    setPendingPreset(preset);
    try {
      const state = careerGameStateFromResponse(
        await careerQuickMatch({ preset, player_name: playerName || null })
      );
      const playerNumber = resolveQuickMatchSeat(careerSeatKey(state.id), state.status);
      saveSetupPreferences("career", {
        mode: "online",
        onlineSub: "quick",
        friendSub,
        targetWins,
        wrongGuessVisibility,
        quickPreset: preset,
      });
      onGameCreated(state, { playerNumber, isOnline: true });
    } catch (err) {
      setError(err.message || "Could not start Career Quiz");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      setPendingPreset(null);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (isQuick || inFlightRef.current) return;
    const code = joinCode.trim().toUpperCase();
    if (isJoin && code.length !== 6) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      if (mode === "solo") {
        saveSetupPreferences("career", {
          mode,
          onlineSub,
          friendSub,
          targetWins,
          wrongGuessVisibility,
        });
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
        saveSetupPreferences("career", {
          mode,
          onlineSub,
          friendSub,
          targetWins,
          wrongGuessVisibility,
        });
        onGameCreated(state, { playerNumber: 1, isOnline: true });
      }
    } catch (err) {
      setError(err.message || "Could not start Career Quiz");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }

  const submitDisabled = loading || (isJoin && joinCode.trim().length !== 6);
  const ctaLabel = !isOnline ? "Start Game" : isJoin ? "Join Game" : "Create Online Game";
  const loadingLabel = isJoin ? "Joining..." : "Starting...";

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
          sub={onlineSub}
          onSubChange={setOnlineSub}
          subModes={ONLINE_SUB_MODES}
        />

        {isFriend && (
          <div className="grid grid-cols-2 gap-1 p-1 mb-6 bg-elq-bg rounded-xl border border-elq-border">
            {FRIEND_SUB_MODES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFriendSub(value)}
                aria-pressed={friendSub === value}
                className={`py-2 rounded-lg text-sm font-semibold transition-colors ${
                  friendSub === value
                    ? "bg-white text-elq-orange shadow-sm"
                    : "text-elq-muted hover:text-elq-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

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
                <NameField value={playerName} onChange={handlePlayerNameChange} />
              </div>
            ) : (
              <div className="space-y-4 mb-8">
                <NameField value={playerName} onChange={handlePlayerNameChange} />
                {isQuick ? (
                  <QuickMatchPanel
                    presets={CAREER_QUICK_MATCH_PRESETS}
                    pools={pools}
                    onPick={handleQuickPick}
                    disabled={loading}
                    pendingPreset={pendingPreset}
                    defaultPreset={prefs?.quickPreset ?? DEFAULT_CAREER_QUICK_MATCH_PRESET}
                  />
                ) : (
                  <div>
                    <SectionCaption>Settings</SectionCaption>
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
              </div>
            )}
          </>
        )}

        {!isQuick && (
          <button
            type="submit"
            disabled={submitDisabled}
            className="w-full py-3.5 px-6 bg-elq-cta text-white font-bold rounded-xl hover:bg-elq-cta-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg tracking-wide"
          >
            {loading ? loadingLabel : ctaLabel}
          </button>
        )}
      </form>
    </GameSetupShell>
  );
}

function careerGameStateFromResponse(response) {
  return response?.state || response?.game || response;
}
