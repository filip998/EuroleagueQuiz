import { useRef, useState } from "react";
import {
  createGuessTheListGame,
  createGuessTheListRaceGame,
  joinGuessTheListGame,
  joinGuessTheListRaceGame,
  quickMatchGuessTheListRace,
} from "./api";
import { getDisplayName, setNickname } from "./identity";
import { useClerkPrefilledName } from "./identityBridge";
import GameSetupShell, { SectionCaption } from "./GameSetupShell";
import GameModeSelector from "./GameModeSelector";
import NameField from "./NameField";
import QuickMatchPanel from "./QuickMatchPanel";
import { resolveQuickMatchSeat } from "./quickMatchSeats";
import {
  DEFAULT_GUESS_THE_LIST_RACE_QUICK_MATCH_PRESET,
  GUESS_THE_LIST_RACE_QUICK_MATCH_PRESETS,
  guessTheListRaceSeatKey,
  legacyGuessTheListRaceSeatKey,
  useGuessTheListRaceQuickMatchPools,
} from "./guessTheListRaceQuickMatch";

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
const CLASSIC_SUB_MODES = [
  ["create", "Create"],
  ["join", "Join"],
];
const RACE_SUB_MODES = [
  ["quick", "Quick Match"],
  ["friend", "Play a Friend"],
];
const FRIEND_SUB_MODES = [
  ["create", "Create"],
  ["join", "Join"],
];
const RACE_LENGTHS = [
  { targetWins: 1, label: "Best of 1" },
  { targetWins: 2, label: "Best of 3" },
  { targetWins: 3, label: "Best of 5" },
];
const CATEGORY_TYPES = [
  ["roster", "Roster"],
  ["all_time", "All-Time Leaders"],
  ["single_season", "Single-Season Leaders"],
  ["all_euroleague", "All-EuroLeague Teams"],
  ["award_winners", "MVP / Awards"],
  ["champions", "Champions"],
];
const SEASONS = Array.from({ length: 26 }, (_, i) => 2000 + i);
const FULL_SEASON_RANGE = { start: SEASONS[0], end: SEASONS[SEASONS.length - 1] };

// All-Time leaders span every season, so its season range is hidden and we
// always submit the full configured range regardless of any prior selection.
function effectiveSeasonRange(categoryType, seasonStart, seasonEnd) {
  if (categoryType === "all_time") return FULL_SEASON_RANGE;
  return { start: seasonStart, end: seasonEnd };
}

export default function GuessTheListSetup({
  onGameCreated,
  onBack,
  initialMode = "solo",
  initialOnlineGameType = "classic",
}) {
  const [mode, setMode] = useState(initialMode === "online" ? "online" : "solo");
  const [onlineGameType, setOnlineGameType] = useState(
    initialOnlineGameType === "race" ? "race" : "classic"
  );
  const [classicSub, setClassicSub] = useState("create");
  const [raceSub, setRaceSub] = useState("quick");
  const [friendSub, setFriendSub] = useState("create");
  const [targetWins, setTargetWins] = useState(3);
  const [raceTargetWins, setRaceTargetWins] = useState(2);
  const [timerMode, setTimerMode] = useState("40s");
  const [categoryType, setCategoryType] = useState("roster");
  const [seasonStart, setSeasonStart] = useState(2000);
  const [seasonEnd, setSeasonEnd] = useState(2025);
  const [player1Name, setPlayer1Name] = useClerkPrefilledName(getDisplayName);
  const [player2Name, setPlayer2Name] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [raceJoinCode, setRaceJoinCode] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pendingPreset, setPendingPreset] = useState(null);
  const inFlightRef = useRef(false);

  const isOnline = mode === "online";
  const isLocal = mode === "local";
  const isRace = isOnline && onlineGameType === "race";
  const isClassicJoin = isOnline && onlineGameType === "classic" && classicSub === "join";
  const isRaceQuick = isRace && raceSub === "quick";
  const isRaceFriend = isRace && raceSub === "friend";
  const isRaceJoin = isRaceFriend && friendSub === "join";
  const showClassicMatchSettings = isLocal || (isOnline && onlineGameType === "classic" && classicSub === "create");
  const { pools } = useGuessTheListRaceQuickMatchPools(isRaceQuick);

  function handleModeChange(nextMode) {
    setMode(nextMode);
    setError(null);
  }

  function handlePlayer1NameChange(value) {
    setPlayer1Name(value);
    if (!isLocal) setNickname(value);
  }

  async function handleQuickPick(preset) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setLoading(true);
    setPendingPreset(preset);
    try {
      const response = await quickMatchGuessTheListRace({
        preset,
        player_name: player1Name || null,
      });
      const game = gameStateFromResponse(response);
      const playerNumber = resolveQuickMatchSeat(
        guessTheListRaceSeatKey(game.id),
        game.status,
        [legacyGuessTheListRaceSeatKey(game.id)]
      );
      onGameCreated(game, { playerNumber, isOnline: true });
    } catch (err) {
      setError(err.message);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      setPendingPreset(null);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (isRaceQuick || inFlightRef.current) return;

    const code = joinCode.trim().toUpperCase();
    const raceCode = raceJoinCode.trim().toUpperCase();
    if (isClassicJoin && code.length !== 6) return;
    if (isRaceJoin && raceCode.length !== 6) return;

    inFlightRef.current = true;
    setLoading(true);
    try {
      if (isClassicJoin) {
        const resp = await joinGuessTheListGame(code, player1Name || null);
        onGameCreated(resp, { playerNumber: 2, isOnline: true, gameId: resp.state.id });
      } else if (isRaceJoin) {
        const resp = await joinGuessTheListRaceGame(raceCode, player1Name || null);
        onGameCreated(resp, { playerNumber: 2, isOnline: true, gameId: resp.state.id });
      } else if (isRaceFriend) {
        const range = effectiveSeasonRange(categoryType, seasonStart, seasonEnd);
        const resp = await createGuessTheListRaceGame({
          target_wins: raceTargetWins,
          category_type: categoryType,
          player1_name: player1Name || null,
          season_range_start: range.start,
          season_range_end: range.end,
        });
        onGameCreated(resp, { playerNumber: 1, isOnline: true });
      } else {
        const range = effectiveSeasonRange(categoryType, seasonStart, seasonEnd);
        const resp = await createGuessTheListGame({
          mode: BACKEND_MODE[mode],
          target_wins: targetWins,
          timer_mode: mode === "solo" ? "unlimited" : timerMode,
          category_type: categoryType,
          player1_name: player1Name || null,
          player2_name: isLocal ? player2Name || null : null,
          season_range_start: range.start,
          season_range_end: range.end,
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

  const submitDisabled = loading
    || (isClassicJoin && joinCode.trim().length !== 6)
    || (isRaceJoin && raceJoinCode.trim().length !== 6);
  const ctaLabel = isRaceJoin
    ? "Join Game"
    : isRaceFriend
      ? "Create Online Game"
      : isClassicJoin
        ? "Join Game"
        : isOnline
          ? "Create Online Game"
          : "Start Game";
  const loadingLabel = isRace ? "Starting race..." : isClassicJoin ? "Joining..." : "Creating...";

  return (
    <GameSetupShell
      accent="player2"
      icon={HEADER_ICON}
      title="GUESS THE LIST"
      tagline="Name rosters, leaders, and award teams from EuroLeague history."
      onHome={onBack}
      error={error}
    >
      <form onSubmit={handleSubmit}>
        <GameModeSelector
          modes={["solo", "local", "online"]}
          mode={mode}
          onModeChange={handleModeChange}
          sub={onlineGameType}
          onSubChange={setOnlineGameType}
          subModes={ONLINE_GAME_TYPES}
          disabled={loading}
        />

        <div className="border-t border-elq-border mb-6" />

        {isRace ? (
          <>
            <SegmentedToggle
              value={raceSub}
              onChange={setRaceSub}
              options={RACE_SUB_MODES}
              disabled={loading}
            />

            {isRaceFriend && (
              <SegmentedToggle
                value={friendSub}
                onChange={setFriendSub}
                options={FRIEND_SUB_MODES}
                disabled={loading}
              />
            )}

            {isRaceQuick ? (
              <>
                <NameField
                  className="mb-6"
                  value={player1Name}
                  onChange={handlePlayer1NameChange}
                  label="Your Name"
                />
                <QuickMatchPanel
                  presets={GUESS_THE_LIST_RACE_QUICK_MATCH_PRESETS}
                  pools={pools}
                  onPick={handleQuickPick}
                  disabled={loading}
                  pendingPreset={pendingPreset}
                  defaultPreset={DEFAULT_GUESS_THE_LIST_RACE_QUICK_MATCH_PRESET}
                />
              </>
            ) : isRaceJoin ? (
              <JoinFields
                code={raceJoinCode}
                onCodeChange={setRaceJoinCode}
                playerName={player1Name}
                onPlayerNameChange={handlePlayer1NameChange}
              />
            ) : (
              <>
                <NameField
                  className="mb-6"
                  value={player1Name}
                  onChange={handlePlayer1NameChange}
                  label="Your Name"
                />
                <ListTypePicker
                  value={categoryType}
                  onChange={setCategoryType}
                  disabled={loading}
                />
                {categoryType !== "all_time" && (
                  <SeasonRange
                    seasonStart={seasonStart}
                    seasonEnd={seasonEnd}
                    setSeasonStart={setSeasonStart}
                    setSeasonEnd={setSeasonEnd}
                  />
                )}
                <SectionCaption>Race length</SectionCaption>
                <select
                  value={raceTargetWins}
                  onChange={(e) => setRaceTargetWins(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer mb-6"
                >
                  {RACE_LENGTHS.map((length) => (
                    <option key={length.targetWins} value={length.targetWins}>
                      {length.label}
                    </option>
                  ))}
                </select>
              </>
            )}
          </>
        ) : (
          <>
            {isOnline && (
              <SegmentedToggle
                value={classicSub}
                onChange={setClassicSub}
                options={CLASSIC_SUB_MODES}
                disabled={loading}
              />
            )}

            {isClassicJoin ? (
              <JoinFields
                code={joinCode}
                onCodeChange={setJoinCode}
                playerName={player1Name}
                onPlayerNameChange={handlePlayer1NameChange}
              />
            ) : (
              <>
                <div className="space-y-4 mb-6">
                  <NameField
                    value={player1Name}
                    onChange={handlePlayer1NameChange}
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

                <ListTypePicker
                  value={categoryType}
                  onChange={setCategoryType}
                  disabled={loading}
                />

                {categoryType !== "all_time" && (
                  <SeasonRange
                    seasonStart={seasonStart}
                    seasonEnd={seasonEnd}
                    setSeasonStart={setSeasonStart}
                    setSeasonEnd={setSeasonEnd}
                  />
                )}

                {showClassicMatchSettings && (
                  <ClassicSettings
                    targetWins={targetWins}
                    setTargetWins={setTargetWins}
                    timerMode={timerMode}
                    setTimerMode={setTimerMode}
                  />
                )}
              </>
            )}
          </>
        )}

        {!isRaceQuick && (
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
    <div className="grid gap-1 p-1 mb-6 bg-elq-bg rounded-xl border border-elq-border" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
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

function ListTypePicker({ value, onChange, disabled = false }) {
  return (
    <>
      <SectionCaption>List Type</SectionCaption>
      <select
        aria-label="List type"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full px-3 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg text-sm focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors appearance-none cursor-pointer mb-6 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {CATEGORY_TYPES.map(([optionValue, label]) => (
          <option key={optionValue} value={optionValue}>
            {label}
          </option>
        ))}
      </select>
    </>
  );
}

function SeasonRange({ seasonStart, seasonEnd, setSeasonStart, setSeasonEnd }) {
  return (
    <>
      <SectionCaption>Season Range</SectionCaption>
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
  );
}

function JoinFields({ code, onCodeChange, playerName, onPlayerNameChange }) {
  return (
    <div className="space-y-4 mb-8">
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wider text-elq-muted mb-2">
          Game Code
        </label>
        <input
          value={code}
          onChange={(e) => onCodeChange(e.target.value.toUpperCase())}
          placeholder="ABC123"
          maxLength={6}
          className="w-full px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors"
        />
      </div>
      <NameField
        value={playerName}
        onChange={onPlayerNameChange}
        label="Your Name"
      />
    </div>
  );
}

function gameStateFromResponse(response) {
  return response?.state || response?.game || response;
}
