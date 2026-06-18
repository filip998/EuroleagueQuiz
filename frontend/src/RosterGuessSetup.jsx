import { useRef, useState } from "react";
import {
  createRosterGame,
  createRosterRaceGame,
  joinRosterGame,
  joinRosterRaceGame,
  quickMatchRosterRace,
} from "./api";
import { getNickname, setNickname, NICKNAME_MAX_LENGTH } from "./identity";
import { useClerkPrefilledName } from "./identityBridge";
import { formatPresence } from "./quickMatch";
import {
  DEFAULT_ROSTER_RACE_QUICK_MATCH_PRESET,
  ROSTER_RACE_QUICK_MATCH_PRESETS,
  rosterRaceSeatKey,
  useRosterRaceQuickMatchPools,
} from "./rosterRaceQuickMatch";
import { resolveQuickMatchSeat } from "./quickMatchSeats";
import GameSetupShell from "./GameSetupShell";
import GameModeSelector from "./GameModeSelector";
import QuickMatchPanel from "./QuickMatchPanel";

const HEADER_ICON = (
  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
  </svg>
);

const BACKEND_MODE = {
  solo: "single_player",
  local: "local_two_player",
  online: "online_friend",
};

const ONLINE_GAME_TYPES = [
  ["classic", "Classic"],
  ["race", "Race"],
];

const FRIEND_SUB_MODES = [
  ["create", "Create"],
  ["join", "Join"],
];

const RACE_SUB_MODES = [
  ["quick", "Quick Match"],
  ["friend", "Play a Friend"],
];

const SEASONS = Array.from({ length: 26 }, (_, i) => 2000 + i);

export default function RosterGuessSetup({
  onGameCreated,
  onBack,
  initialMode = "solo",
  initialGameType = "classic",
}) {
  const [mode, setMode] = useState(initialMode === "online" ? "online" : "solo");
  const [onlineGameType, setOnlineGameType] = useState(
    initialGameType === "race" ? "race" : "classic"
  );
  const [classicSub, setClassicSub] = useState("create");
  const [raceSub, setRaceSub] = useState(initialGameType === "race" ? "quick" : "friend");
  const [raceFriendSub, setRaceFriendSub] = useState("create");
  const [targetWins, setTargetWins] = useState(3);
  const [raceTargetWins, setRaceTargetWins] = useState(3);
  const [timerMode, setTimerMode] = useState("40s");
  const [seasonStart, setSeasonStart] = useState(2000);
  const [seasonEnd, setSeasonEnd] = useState(2025);
  const [player1Name, setPlayer1Name] = useClerkPrefilledName(getNickname);
  const [player2Name, setPlayer2Name] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pendingPreset, setPendingPreset] = useState(null);
  const inFlightRef = useRef(false);

  const isOnline = mode === "online";
  const isRace = isOnline && onlineGameType === "race";
  const isClassicOnline = isOnline && onlineGameType === "classic";
  const isRaceQuick = isRace && raceSub === "quick";
  const isRaceFriend = isRace && raceSub === "friend";
  const isClassicJoin = isClassicOnline && classicSub === "join";
  const isRaceJoin = isRaceFriend && raceFriendSub === "join";
  const isJoin = isClassicJoin || isRaceJoin;
  const isLocal = mode === "local";
  const showClassicSettings = isLocal || (isClassicOnline && classicSub === "create");
  const showRaceSettings = isRaceFriend && raceFriendSub === "create";
  const showSeasonRange = !isJoin && !isRaceQuick;
  const { pools } = useRosterRaceQuickMatchPools(isRaceQuick);

  function handlePlayer1NameChange(value) {
    setPlayer1Name(value);
    if (!isLocal) setNickname(value);
  }

  async function handleQuickPick(preset) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setPendingPreset(preset);
    try {
      const response = await quickMatchRosterRace({
        preset,
        player_name: player1Name || null,
      });
      const game = gameStateFromResponse(response);
      const playerNumber = resolveQuickMatchSeat(
        rosterRaceSeatKey(game.id),
        game.status
      );
      onGameCreated(game, { playerNumber, isOnline: true });
    } catch (err) {
      setError(err.message || "Could not start Race Quick Match");
    } finally {
      inFlightRef.current = false;
      setPendingPreset(null);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const code = joinCode.trim().toUpperCase();
    if (isJoin && code.length !== 6) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      if (isRaceJoin) {
        const resp = await joinRosterRaceGame(code, player1Name || null);
        onGameCreated(resp, { playerNumber: 2, isOnline: true, gameId: resp.state.id });
      } else if (isClassicJoin) {
        const resp = await joinRosterGame(code, player1Name || null);
        onGameCreated(resp, { playerNumber: 2, isOnline: true, gameId: resp.state.id });
      } else if (isRace) {
        const resp = await createRosterRaceGame({
          target_wins: raceTargetWins,
          player1_name: player1Name || null,
          season_range_start: seasonStart,
          season_range_end: seasonEnd,
        });
        onGameCreated(resp, { playerNumber: 1, isOnline: true });
      } else {
        const resp = await createRosterGame({
          mode: BACKEND_MODE[mode],
          target_wins: targetWins,
          timer_mode: mode === "solo" ? "unlimited" : timerMode,
          player1_name: player1Name || null,
          player2_name: isLocal ? player2Name || null : null,
          season_range_start: seasonStart,
          season_range_end: seasonEnd,
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
  const ctaLabel = isJoin
    ? "Join Game"
    : isRace
      ? "Create Race Game"
      : isOnline
        ? "Create Online Game"
        : "Start Game";
  const loadingLabel = isJoin ? "Joining..." : "Creating...";

  return (
    <GameSetupShell
      accent="player2"
      icon={HEADER_ICON}
      title="ROSTER GUESS"
      tagline="Name every player on the roster."
      onHome={onBack}
      error={error}
    >
      <form onSubmit={handleSubmit}>
        <GameModeSelector
          modes={["solo", "local", "online"]}
          mode={mode}
          onModeChange={setMode}
          sub={onlineGameType}
          onSubChange={setOnlineGameType}
          subModes={ONLINE_GAME_TYPES}
          disabled={Boolean(pendingPreset)}
        />

        {isClassicOnline && (
          <SegmentedToggle
            value={classicSub}
            onChange={setClassicSub}
            options={FRIEND_SUB_MODES}
            disabled={Boolean(pendingPreset)}
          />
        )}

        {isRace && (
          <SegmentedToggle
            value={raceSub}
            onChange={setRaceSub}
            options={RACE_SUB_MODES}
            disabled={Boolean(pendingPreset)}
          />
        )}

        {isRaceFriend && (
          <SegmentedToggle
            value={raceFriendSub}
            onChange={setRaceFriendSub}
            options={FRIEND_SUB_MODES}
            disabled={Boolean(pendingPreset)}
          />
        )}

        <div className="border-t border-elq-border mb-6" />

        {isJoin ? (
          <JoinFields
            joinCode={joinCode}
            setJoinCode={setJoinCode}
            playerName={player1Name}
            onPlayerNameChange={handlePlayer1NameChange}
          />
        ) : (
          <>
            {showSeasonRange && (
              <SeasonRange
                seasonStart={seasonStart}
                setSeasonStart={setSeasonStart}
                seasonEnd={seasonEnd}
                setSeasonEnd={setSeasonEnd}
              />
            )}

            {showClassicSettings && (
              <ClassicSettings
                targetWins={targetWins}
                setTargetWins={setTargetWins}
                timerMode={timerMode}
                setTimerMode={setTimerMode}
              />
            )}

            {showRaceSettings && (
              <RaceSettings
                raceTargetWins={raceTargetWins}
                setRaceTargetWins={setRaceTargetWins}
              />
            )}

            <NameFields
              isLocal={isLocal}
              player1Name={player1Name}
              onPlayer1NameChange={handlePlayer1NameChange}
              player2Name={player2Name}
              setPlayer2Name={setPlayer2Name}
            />
          </>
        )}

        {isRaceQuick ? (
          <QuickMatchPanel
            presets={ROSTER_RACE_QUICK_MATCH_PRESETS}
            pools={pools}
            onPick={handleQuickPick}
            disabled={Boolean(pendingPreset)}
            pendingPreset={pendingPreset}
            defaultPreset={DEFAULT_ROSTER_RACE_QUICK_MATCH_PRESET}
            formatPresence={formatPresence}
          />
        ) : (
          <button
            type="submit"
            disabled={submitDisabled}
            className="w-full py-3.5 px-6 bg-elq-orange text-white font-bold rounded-xl hover:bg-elq-orange-dark active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed text-lg tracking-wide"
          >
            {loading ? loadingLabel : ctaLabel}
          </button>
        )}
      </form>
    </GameSetupShell>
  );
}

function SegmentedToggle({ value, onChange, options, disabled = false }) {
  return (
    <div
      className="grid gap-1 p-1 mb-6 bg-elq-bg rounded-xl border border-elq-border"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map(([optionValue, label]) => (
        <button
          key={optionValue}
          type="button"
          onClick={() => onChange(optionValue)}
          disabled={disabled}
          aria-pressed={value === optionValue}
          className={`py-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            value === optionValue
              ? "bg-white text-elq-orange shadow-sm"
              : "text-elq-muted hover:text-elq-text"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function JoinFields({ joinCode, setJoinCode, playerName, onPlayerNameChange }) {
  return (
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
          onChange={(e) => onPlayerNameChange(e.target.value)}
          placeholder="Your name"
          maxLength={NICKNAME_MAX_LENGTH}
          className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
        />
      </div>
    </div>
  );
}

function SeasonRange({ seasonStart, setSeasonStart, seasonEnd, setSeasonEnd }) {
  return (
    <>
      <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
        Season Range
      </label>
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm text-elq-text mb-1.5">From</label>
          <select
            value={seasonStart}
            onChange={(e) => {
              const value = Number(e.target.value);
              setSeasonStart(value);
              if (value > seasonEnd) setSeasonEnd(value);
            }}
            className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
          >
            {SEASONS.map((year) => (
              <option key={year} value={year}>{year}/{String(year + 1).slice(2)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-elq-text mb-1.5">To</label>
          <select
            value={seasonEnd}
            onChange={(e) => setSeasonEnd(Number(e.target.value))}
            className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
          >
            {SEASONS.filter((year) => year >= seasonStart).map((year) => (
              <option key={year} value={year}>{year}/{String(year + 1).slice(2)}</option>
            ))}
          </select>
        </div>
      </div>
    </>
  );
}

function ClassicSettings({ targetWins, setTargetWins, timerMode, setTimerMode }) {
  return (
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
  );
}

function RaceSettings({ raceTargetWins, setRaceTargetWins }) {
  return (
    <>
      <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-3">
        Race Settings
      </label>
      <div className="grid grid-cols-1 gap-4 mb-6">
        <div>
          <label className="block text-sm text-elq-text mb-1.5">First to</label>
          <select
            value={raceTargetWins}
            onChange={(e) => setRaceTargetWins(Number(e.target.value))}
            className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer"
          >
            <option value={1}>1 win</option>
            <option value={3}>3 wins</option>
            <option value={5}>5 wins</option>
          </select>
        </div>
      </div>
    </>
  );
}

function NameFields({
  isLocal,
  player1Name,
  onPlayer1NameChange,
  player2Name,
  setPlayer2Name,
}) {
  return (
    <div className="space-y-4 mb-8">
      <div>
        <label className="block text-sm text-elq-text mb-1.5">
          {isLocal ? "Player 1" : "Your Name"}
        </label>
        <input
          value={player1Name}
          onChange={(e) => onPlayer1NameChange(e.target.value)}
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
  );
}

function gameStateFromResponse(response) {
  return response?.state || response?.game || response;
}
