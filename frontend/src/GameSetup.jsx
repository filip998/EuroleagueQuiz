import { useRef, useState } from "react";
import { createGame, joinGame, quickMatchTicTacToe } from "./api";
import { getDisplayName, setNickname } from "./identity";
import { useClerkPrefilledName } from "./identityBridge";
import { normalizeJoinCode } from "./inviteLink";
import {
  QUICK_MATCH_PRESETS,
  DEFAULT_QUICK_MATCH_PRESET,
  useQuickMatchPools,
} from "./quickMatch";
import { resolveQuickMatchSeat } from "./quickMatchSeats";
import GameSetupShell, { SectionCaption } from "./GameSetupShell";
import GameModeSelector from "./GameModeSelector";
import NameField from "./NameField";
import QuickMatchPanel from "./QuickMatchPanel";

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
  // Online is the default landing so Quick Match (the prominent, near-one-click
  // way to play online) is the first thing shown. A valid invite code instead
  // lands on Online -> Play a Friend -> Join with the code prefilled.
  const [mode, setMode] = useState("online");
  // Online sub-mode: "quick" (matchmaking pool) | "friend" (private game).
  const [onlineSub, setOnlineSub] = useState(prefillCode ? "friend" : "quick");
  // Friend sub-mode: "create" | "join".
  const [friendSub, setFriendSub] = useState(prefillCode ? "join" : "create");
  const [targetWins, setTargetWins] = useState(3);
  const [timerMode, setTimerMode] = useState("40s");
  const [player1Name, setPlayer1Name] = useClerkPrefilledName(getDisplayName);
  // Local 1v1's "Player 1" gets its own non-prefilled state so both local fields
  // stay neutral placeholders ("Player 1"/"Player 2") instead of seeding the
  // signed-in guest/display name into Player 1 only (which implied "you").
  const [localPlayer1Name, setLocalPlayer1Name] = useState("");
  const [player2Name, setPlayer2Name] = useState("");
  const [joinCode, setJoinCode] = useState(prefillCode);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  // One-click Quick Match: `pendingPreset` is the pool whose request is in
  // flight, and `picking` freezes the whole panel + mode controls so a fast
  // multi-tap can't open several waiting games for the same guest.
  const [pendingPreset, setPendingPreset] = useState(null);
  const picking = pendingPreset !== null;
  const inFlightRef = useRef(false);

  const isOnline = mode === "online";
  const isLocal = mode === "local";
  const isSolo = mode === "solo";
  const isQuick = isOnline && onlineSub === "quick";
  const isFriend = isOnline && onlineSub === "friend";
  const isJoin = isFriend && friendSub === "join";
  const isCreate = isFriend && friendSub === "create";
  const showMatchSettings = isLocal || isCreate;

  const { pools } = useQuickMatchPools(isQuick);

  // The shared name field is the persisted nickname in solo / online / friend.
  // Local 1v1's "Player 1" uses a separate, non-persisted state
  // (localPlayer1Name), so this handler only drives the nickname field; the
  // `!isLocal` guard stays as a defensive backstop.
  function handlePlayer1NameChange(value) {
    setPlayer1Name(value);
    if (!isLocal) setNickname(value);
  }

  // One tap on a pool card enters that pool immediately — no separate submit.
  async function handleQuickPick(presetKey) {
    // Synchronous guard: state updates are async, so the ref is what actually
    // blocks a second tap that fires before this one re-renders.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPendingPreset(presetKey);
    setError(null);
    try {
      const resp = await quickMatchTicTacToe({
        preset: presetKey,
        player_name: player1Name.trim() || null,
      });
      const game = resp.state;
      const playerNumber = resolveQuickMatchSeat(game.id, game.status);
      onGameCreated(resp, { playerNumber, isOnline: true });
      // On success the parent navigates away (this component unmounts), so we
      // intentionally leave the panel disabled instead of touching state on an
      // unmounting tree.
    } catch (err) {
      setError(err.message);
      inFlightRef.current = false;
      setPendingPreset(null);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    // Quick Match is one-click via the pool cards; the form only drives the
    // Solo / Local 1v1 / Play-a-Friend paths (so an Enter keypress in the
    // optional name field can't fall through to a friend game).
    if (isQuick) return;
    setError(null);
    const code = joinCode.trim().toUpperCase();
    if (isJoin && code.length !== 6) return;
    // Synchronous guard against rapid double submits creating two games.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      if (isJoin) {
        const resp = await joinGame(code, player1Name || null);
        onGameCreated(resp, { playerNumber: 2, isOnline: true, gameId: resp.state.id });
      } else {
        const resp = await createGame({
          mode: BACKEND_MODE[mode],
          target_wins: targetWins,
          timer_mode: mode === "solo" ? "unlimited" : timerMode,
          player1_name: (isLocal ? localPlayer1Name : player1Name).trim() || null,
          player2_name: isLocal ? player2Name.trim() || null : null,
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
  const ctaLabel = isJoin ? "Join Game" : isOnline ? "Create Online Game" : "Start Game";
  const loadingLabel = isJoin ? "Joining..." : "Creating...";

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
          disabled={picking}
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

        {isQuick ? (
          <>
            <NameField
              className="mb-6"
              value={player1Name}
              onChange={handlePlayer1NameChange}
              disabled={picking}
            />
            <QuickMatchPanel
              presets={QUICK_MATCH_PRESETS}
              pools={pools}
              onPick={handleQuickPick}
              disabled={picking}
              pendingPreset={pendingPreset}
              defaultPreset={DEFAULT_QUICK_MATCH_PRESET}
            />
          </>
        ) : (
          <>
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
                <NameField value={player1Name} onChange={handlePlayer1NameChange} />
              </div>
            ) : (
              <>
                {isSolo ? (
                  <div className="mb-6 rounded-xl border border-elq-border bg-elq-bg/60 px-4 py-3 text-sm text-elq-muted">
                    Solo challenge — claim three in a row before three strikes. No name needed.
                  </div>
                ) : (
                  <div className="space-y-4 mb-6">
                    <NameField
                      value={isLocal ? localPlayer1Name : player1Name}
                      onChange={isLocal ? setLocalPlayer1Name : handlePlayer1NameChange}
                      label={isLocal ? "Player 1" : "Your Name"}
                      placeholder={isLocal ? "Player 1" : "Your name"}
                    />
                    {isLocal && (
                      <NameField
                        value={player2Name}
                        onChange={setPlayer2Name}
                        label="Player 2"
                        placeholder="Player 2"
                      />
                    )}
                  </div>
                )}

                {showMatchSettings && (
                  <>
                    <SectionCaption>Settings</SectionCaption>
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
              </>
            )}

            <button
              type="submit"
              disabled={submitDisabled}
              className="w-full py-3.5 px-6 bg-elq-cta text-white font-bold rounded-xl hover:bg-elq-cta-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg tracking-wide"
            >
              {loading ? loadingLabel : ctaLabel}
            </button>
          </>
        )}
      </form>
    </GameSetupShell>
  );
}
