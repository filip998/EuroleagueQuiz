import { useRef, useState } from "react";
import { createGame, joinGame, quickMatchTicTacToe } from "./api";
import { getNickname, setNickname, NICKNAME_MAX_LENGTH } from "./identity";
import { normalizeJoinCode } from "./inviteLink";
import {
  QUICK_MATCH_PRESETS,
  DEFAULT_QUICK_MATCH_PRESET,
  formatPresence,
  useQuickMatchPools,
} from "./quickMatch";
import { resolveQuickMatchSeat } from "./quickMatchSeats";
import GameSetupShell from "./GameSetupShell";
import GameModeSelector from "./GameModeSelector";

const HEADER_ICON = (
  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />
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

const BACKEND_MODE = {
  solo: "single_player",
  local: "local_two_player",
  online: "online_friend",
};

export default function GameSetup({ onGameCreated, onBack, initialJoinCode = "" }) {
  const prefillCode = normalizeJoinCode(initialJoinCode);
  const [mode, setMode] = useState(prefillCode ? "online" : "solo");
  // Online sub-mode: "quick" (matchmaking pool) | "friend" (private game).
  const [onlineSub, setOnlineSub] = useState(prefillCode ? "friend" : "quick");
  // Friend sub-mode: "create" | "join".
  const [friendSub, setFriendSub] = useState(prefillCode ? "join" : "create");
  const [preset, setPreset] = useState(DEFAULT_QUICK_MATCH_PRESET);
  const [targetWins, setTargetWins] = useState(3);
  const [timerMode, setTimerMode] = useState("40s");
  const [player1Name, setPlayer1Name] = useState(() => getNickname());
  const [player2Name, setPlayer2Name] = useState("");
  const [joinCode, setJoinCode] = useState(prefillCode);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  const isOnline = mode === "online";
  const isLocal = mode === "local";
  const isQuick = isOnline && onlineSub === "quick";
  const isFriend = isOnline && onlineSub === "friend";
  const isJoin = isFriend && friendSub === "join";
  const isCreate = isFriend && friendSub === "create";
  const showMatchSettings = isLocal || isCreate;

  const { pools } = useQuickMatchPools(isQuick);

  // The name field doubles as the shared nickname in solo/online, but as the
  // local "Player 1" label in local 1v1 — only persist the former.
  function handlePlayer1NameChange(value) {
    setPlayer1Name(value);
    if (!isLocal) setNickname(value);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const code = joinCode.trim().toUpperCase();
    if (isJoin && code.length !== 6) return;
    // Synchronous guard against rapid double submits creating two games.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      if (isQuick) {
        const resp = await quickMatchTicTacToe({
          preset,
          player_name: player1Name || null,
        });
        const game = resp.state;
        const playerNumber = resolveQuickMatchSeat(game.id, game.status);
        onGameCreated(resp, { playerNumber, isOnline: true });
      } else if (isJoin) {
        const resp = await joinGame(code, player1Name || null);
        onGameCreated(resp, { playerNumber: 2, isOnline: true, gameId: resp.state.id });
      } else {
        const resp = await createGame({
          mode: BACKEND_MODE[mode],
          target_wins: targetWins,
          timer_mode: mode === "solo" ? "unlimited" : timerMode,
          player1_name: player1Name || null,
          player2_name: isLocal ? player2Name || null : null,
        });
        if (isOnline) {
          onGameCreated(resp, { playerNumber: 1, isOnline: true });
        } else {
          onGameCreated(resp);
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }

  const submitDisabled = loading || (isJoin && joinCode.trim().length !== 6);
  const ctaLabel = isQuick
    ? "Find Match"
    : isJoin
      ? "Join Game"
      : isOnline
        ? "Create Online Game"
        : "Start Game";
  const loadingLabel = isQuick ? "Finding match…" : isJoin ? "Joining..." : "Creating...";

  return (
    <GameSetupShell
      accent="player1"
      icon={HEADER_ICON}
      title="TICTACTOE"
      tagline="Claim the grid with the right players."
      onHome={onBack}
      error={error}
    >
      <form onSubmit={handleSubmit}>
        <GameModeSelector
          modes={["solo", "local", "online"]}
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
                value={player1Name}
                onChange={(e) => handlePlayer1NameChange(e.target.value)}
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
                  {QUICK_MATCH_PRESETS.map((p) => {
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

            {showMatchSettings && (
              <>
                <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
                  Settings
                </label>
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div>
                    <label className="block text-sm text-elq-text mb-1.5">First to</label>
                    <select
                      value={targetWins}
                      onChange={(e) => setTargetWins(Number(e.target.value))}
                      className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                    >
                      <option value={2}>2 wins</option>
                      <option value={3}>3 wins</option>
                      <option value={5}>5 wins</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-elq-text mb-1.5">Turn timer</label>
                    <select
                      value={timerMode}
                      onChange={(e) => setTimerMode(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
                    >
                      <option value="15s">15 seconds</option>
                      <option value="40s">40 seconds</option>
                      <option value="unlimited">Unlimited</option>
                    </select>
                  </div>
                </div>
              </>
            )}

            <div className="space-y-4 mb-8">
              <div>
                <label className="block text-sm text-elq-text mb-1.5">
                  {isLocal ? "Player 1" : "Your Name"}
                </label>
                <input
                  value={player1Name}
                  onChange={(e) => handlePlayer1NameChange(e.target.value)}
                  placeholder={isLocal ? "Player 1" : "Your name"}
                  maxLength={NICKNAME_MAX_LENGTH}
                  className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                />
              </div>
              {isLocal && (
                <div>
                  <label className="block text-sm text-elq-text mb-1.5">Player 2</label>
                  <input
                    value={player2Name}
                    onChange={(e) => setPlayer2Name(e.target.value)}
                    placeholder="Player 2"
                    className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
                  />
                </div>
              )}
            </div>
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
