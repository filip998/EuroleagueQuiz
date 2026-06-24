// Builds the TicTacToe player-search prompt from the two clues of a board cell.
//
// A board cell pairs a row axis and a column axis, each one of several axis
// types (team, nationality, played_with, season, position, champion,
// stat_milestone). The old prompt hard-coded a team-vs-team sentence, which
// rendered blank slots or raw upstream codes for the non-team clues. This
// derives a grammatical sentence for every pairing straight from each axis's
// `display_label`, so the most important instruction on screen is always right.
//
// The output is a flat list of parts so the renderer can emphasise the clue
// values without this module depending on React: each part is either
// `{ text }` (plain) or `{ strong }` (emphasised).

// Country names that read naturally only with a leading "the" (plural names,
// unions, federations and republics). Matched on the structural noun so the
// list of nationalities never has to be enumerated here.
const COUNTRY_NEEDS_ARTICLE =
  /\b(Republic|Kingdom|States|Emirates|Federation|Netherlands|Bahamas|Philippines|Islands|Congo)\b/i;

function axisLabel(axis) {
  return (axis && (axis.display_label || axis.team_name)) || "";
}

// The predicate describing what a player did for a single clue, e.g.
// "played for <strong>Real Madrid</strong>". Used for clue pairings that the
// backend matches as two independent facts joined by "and".
function axisClauseParts(axis) {
  const type = axis?.axis_type;
  const label = axisLabel(axis);
  switch (type) {
    case "team":
      return [{ text: "played for " }, { strong: label }];
    case "nationality": {
      const article = COUNTRY_NEEDS_ARTICLE.test(label) ? "the " : "";
      return [{ text: `is from ${article}` }, { strong: label }];
    }
    case "played_with":
      return [{ text: "was a teammate of " }, { strong: label }];
    case "season":
      return [{ text: "played in the " }, { strong: label }, { text: " season" }];
    case "position":
      return [{ text: "played as a " }, { strong: label }];
    case "champion":
      // Data-driven from the chip label ("EuroLeague champion") so it adapts if
      // the backend ever introduces another title.
      return [{ text: "was a " }, { strong: label || "EuroLeague champion" }];
    case "stat_milestone": {
      // Season-average milestones ("15+ PPG season") read as a single countable
      // achievement and take "a"; career/single-game ones ("1,000+ career
      // points", "30+ points in a game") do not.
      const article = label.trim().toLowerCase().endsWith("season") ? "a " : "";
      return [{ text: `had ${article}` }, { strong: label }];
    }
    default:
      return [{ text: "matches " }, { strong: label || "this clue" }];
  }
}

const PROMPT_PREFIX = "Find a player who ";

// Builds the full prompt as a list of `{ text }` / `{ strong }` parts.
export function buildCluePromptParts(rowAxis, colAxis) {
  const rowType = rowAxis?.axis_type;
  const colType = colAxis?.axis_type;

  // Both clues are teams: the natural "played for both A and B" phrasing.
  if (rowType === "team" && colType === "team") {
    return [
      { text: `${PROMPT_PREFIX}played for both ` },
      { strong: axisLabel(rowAxis) },
      { text: " and " },
      { strong: axisLabel(colAxis) },
    ];
  }

  // Season pairings the backend matches as a same-season join (not two
  // independent facts), so they need explicit "in the <season> season" wording.
  const seasonAxis =
    rowType === "season" ? rowAxis : colType === "season" ? colAxis : null;
  const otherAxis =
    seasonAxis === rowAxis
      ? colAxis
      : seasonAxis === colAxis
        ? rowAxis
        : null;

  if (seasonAxis && otherAxis?.axis_type === "team") {
    return [
      { text: `${PROMPT_PREFIX}played for ` },
      { strong: axisLabel(otherAxis) },
      { text: " in the " },
      { strong: axisLabel(seasonAxis) },
      { text: " season" },
    ];
  }
  if (seasonAxis && otherAxis?.axis_type === "played_with") {
    return [
      { text: `${PROMPT_PREFIX}was a teammate of ` },
      { strong: axisLabel(otherAxis) },
      { text: " in the " },
      { strong: axisLabel(seasonAxis) },
      { text: " season" },
    ];
  }

  // Everything else is two independent clues joined by "and".
  return [
    { text: PROMPT_PREFIX },
    ...axisClauseParts(rowAxis),
    { text: " and " },
    ...axisClauseParts(colAxis),
  ];
}
