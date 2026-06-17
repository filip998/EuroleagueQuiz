import { useRef, useState } from "react";
import {
  createPhotoGame,
  createPhotoSoloRound,
  joinPhotoGame,
  photoQuickMatch,
} from "./api";
import { getNickname, setNickname, NICKNAME_MAX_LENGTH } from "./identity";
import { useClerkPrefilledName } from "./identityBridge";
import { formatPresence } from "./quickMatch";
import {
  PHOTO_QUICK_MATCH_PRESETS,
  DEFAULT_PHOTO_QUICK_MATCH_PRESET,
  usePhotoQuickMatchPools,
  photoSeatKey,
} from "./photoQuickMatch";
import { resolveQuickMatchSeat } from "./quickMatchSeats";
import GameSetupShell from "./GameSetupShell";
import GameModeSelector from "./GameModeSelector";

const HEADER_ICON = (
  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
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

export default function PhotoQuizSetup({ onSoloRound, onGameCreated, onGameJoined, onBack }) {
  const [mode, setMode] = useState("solo");
  // Online sub-mode: "quick" (matchmaking pool) | "friend" (private game).
  const [onlineSub, setOnlineSub] = useState("quick");
  // Friend sub-mode: "create" | "join".
  const [friendSub, setFriendSub] = useState("create");
  const [preset, setPreset] = useState(DEFAULT_PHOTO_QUICK_MATCH_PRESET);
  const [playerName, setPlayerName] = useClerkPrefilledName(getNickname);
  const [joinCode, setJoinCode] = useState("");
  const [targetWins, setTargetWins] = useState(3);
  const [wrongGuessVisibility, setWrongGuessVisibility] = useState("private");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inFlightRef = useRef(false);

  const isOnline = mode === "online";
  const isQuick = isOnline && onlineSub === "quick";
  const isFriend = isOnline && onlineSub === "friend";
  const isJoin = isFriend && friendSub === "join";
  const isCreate = isFriend && friendSub === "create";

  const { pools } = usePhotoQuickMatchPools(isQuick);

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
    // Synchronous guard against rapid double submits creating two games.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      if (mode === "solo") {
        onSoloRound(await createPhotoSoloRound([]));
      } else if (isQuick) {
        const game = photoGameStateFromResponse(
          await photoQuickMatch({ preset, player_name: playerName || null })
        );
        const playerNumber = resolveQuickMatchSeat(photoSeatKey(game.id), game.status);
        onGameCreated(game, { playerNumber, isOnline: true });
      } else if (isJoin) {
        const game = photoGameStateFromResponse(
          await joinPhotoGame(code, playerName || "Player 2")
        );
        onGameJoined(game, { playerNumber: 2, isOnline: true });
      } else {
        const game = photoGameStateFromResponse(
          await createPhotoGame({
            target_wins: targetWins,
            wrong_guess_visibility: wrongGuessVisibility,
            player1_name: playerName || "Player 1",
          })
        );
        onGameCreated(game, { playerNumber: 1, isOnline: true });
      }
    } catch (err) {
      setError(err.message || "Could not start Photo Quiz");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }

  const submitDisabled = loading || (isJoin && joinCode.trim().length !== 6);
  const ctaLabel = !isOnline
    ? "Start Game"
    : isQuick
      ? "Find Match"
      : isJoin
        ? "Join Game"
        : "Create Online Game";
  const loadingLabel = isQuick ? "Finding match…" : isJoin ? "Joining..." : "Starting...";

  return (
    <GameSetupShell
      accent="violet"
      icon={HEADER_ICON}
      title="PHOTO QUIZ"
      tagline="Name the player from his photo."
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
              <>
                {isQuick && (
                  <div className="mb-6">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
                      Pick a pool
                    </label>
                    <div className="space-y-2.5">
                      {PHOTO_QUICK_MATCH_PRESETS.map((p) => {
                        const active = preset === p.key;
                        return (
                          <button
                            key={p.key}
                            type="button"
                            onClick={() => setPreset(p.key)}
                            aria-pressed={active}
                            className={`w-full flex items-center justify-between gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
                              active
                                ? "border-elq-orange bg-elq-orange/5"
                                : "border-elq-border hover:border-gray-300"
                            }`}
                          >
                            <div>
                              <div className={`font-semibold text-sm ${active ? "text-elq-orange" : "text-elq-text"}`}>
                                {p.label}
                              </div>
                              <div className="text-[11px] text-elq-muted mt-0.5">{p.detail}</div>
                            </div>
                            <div className="text-[11px] text-elq-muted text-right whitespace-nowrap" data-testid={`presence-${p.key}`}>
                              {formatPresence(pools?.[p.key])}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {isCreate && (
                  <div className="grid grid-cols-2 gap-4 mb-6">
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
                )}

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
                </div>
              </>
            )}
          </>
        )}

        <button
          type="submit"
          disabled={submitDisabled}
          className="w-full py-3.5 px-6 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg tracking-wide"
        >
          {loading ? loadingLabel : ctaLabel}
        </button>
      </form>
    </GameSetupShell>
  );
}

function photoGameStateFromResponse(response) {
  return response?.state || response?.game || response;
}
