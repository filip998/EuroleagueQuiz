import { describe, it, expect } from "vitest";
import { buildCluePromptParts } from "../cluePrompt";

// Flatten parts to the full sentence string the user reads.
const sentence = (parts) =>
  parts.map((p) => (p.strong !== undefined ? p.strong : p.text)).join("");
// The emphasised clue values (bold spans).
const strongs = (parts) =>
  parts.filter((p) => p.strong !== undefined).map((p) => p.strong);

const team = (name, code) => ({
  axis_type: "team",
  value: "1",
  display_label: name,
  team_code: code,
  team_name: name,
});
const nationality = (name) => ({
  axis_type: "nationality",
  value: name,
  display_label: name,
});
const playedWith = (name) => ({
  axis_type: "played_with",
  value: "99",
  display_label: name,
});
const season = (label) => ({ axis_type: "season", value: "5", display_label: label });
const position = (role) => ({ axis_type: "position", value: role, display_label: role });
const champion = () => ({
  axis_type: "champion",
  value: "euroleague_champion",
  display_label: "EuroLeague champion",
});
const milestone = (label) => ({
  axis_type: "stat_milestone",
  value: "m",
  display_label: label,
});

const virtus = team("Virtus Bologna", "VIR");
const madrid = team("Real Madrid", "RMB");

describe("buildCluePromptParts — exact sentences", () => {
  it("team x team uses the natural 'played for both' form with full club names", () => {
    const parts = buildCluePromptParts(virtus, madrid);
    expect(sentence(parts)).toBe(
      "Find a player who played for both Virtus Bologna and Real Madrid"
    );
    expect(strongs(parts)).toEqual(["Virtus Bologna", "Real Madrid"]);
  });

  it("team x nationality reads grammatically (row order)", () => {
    expect(sentence(buildCluePromptParts(madrid, nationality("Serbia")))).toBe(
      "Find a player who played for Real Madrid and is from Serbia"
    );
  });

  it("nationality x team reads grammatically (reversed order)", () => {
    expect(sentence(buildCluePromptParts(nationality("Serbia"), madrid))).toBe(
      "Find a player who is from Serbia and played for Real Madrid"
    );
  });

  it("team x played_with names the teammate", () => {
    expect(
      sentence(buildCluePromptParts(madrid, playedWith("Vasilije Mičić")))
    ).toBe(
      "Find a player who played for Real Madrid and was a teammate of Vasilije Mičić"
    );
  });

  it("team x champion is data-driven from the chip label", () => {
    expect(sentence(buildCluePromptParts(virtus, champion()))).toBe(
      "Find a player who played for Virtus Bologna and was a EuroLeague champion"
    );
  });

  it("team x position reads grammatically", () => {
    expect(sentence(buildCluePromptParts(madrid, position("Guard")))).toBe(
      "Find a player who played for Real Madrid and played as a Guard"
    );
  });

  it("team x stat_milestone (season average) takes the article", () => {
    expect(sentence(buildCluePromptParts(madrid, milestone("15+ PPG season")))).toBe(
      "Find a player who played for Real Madrid and had a 15+ PPG season"
    );
  });

  it("team x stat_milestone (career total) drops the article", () => {
    expect(
      sentence(buildCluePromptParts(madrid, milestone("1,000+ career points")))
    ).toBe(
      "Find a player who played for Real Madrid and had 1,000+ career points"
    );
  });

  it("team x stat_milestone (single game) drops the article", () => {
    expect(
      sentence(buildCluePromptParts(madrid, milestone("30+ points in a game")))
    ).toBe(
      "Find a player who played for Real Madrid and had 30+ points in a game"
    );
  });
});

describe("buildCluePromptParts — season same-season pairings", () => {
  it("team x season collapses to 'in the <season> season' (backend joins on season)", () => {
    expect(sentence(buildCluePromptParts(virtus, season("2015/16")))).toBe(
      "Find a player who played for Virtus Bologna in the 2015/16 season"
    );
  });

  it("season x team puts the team first regardless of row/col order", () => {
    expect(sentence(buildCluePromptParts(season("2015/16"), virtus))).toBe(
      "Find a player who played for Virtus Bologna in the 2015/16 season"
    );
  });

  it("played_with x season collapses to a same-season teammate clue", () => {
    expect(
      sentence(buildCluePromptParts(playedWith("Vasilije Mičić"), season("2015/16")))
    ).toBe(
      "Find a player who was a teammate of Vasilije Mičić in the 2015/16 season"
    );
  });

  it("season x nationality stays the independent 'and' form (backend matches independently)", () => {
    expect(
      sentence(buildCluePromptParts(season("2015/16"), nationality("Serbia")))
    ).toBe(
      "Find a player who played in the 2015/16 season and is from Serbia"
    );
  });

  it("season x champion stays the independent 'and' form", () => {
    expect(sentence(buildCluePromptParts(season("2015/16"), champion()))).toBe(
      "Find a player who played in the 2015/16 season and was a EuroLeague champion"
    );
  });
});

describe("buildCluePromptParts — nationality articles", () => {
  it.each([
    ["United States of America", "the United States of America"],
    ["United Kingdom", "the United Kingdom"],
    ["Netherlands", "the Netherlands"],
    ["Dominican Republic", "the Dominican Republic"],
    ["Czech Republic", "the Czech Republic"],
    ["Russian Federation", "the Russian Federation"],
    ["Bahamas", "the Bahamas"],
  ])("adds 'the' for %s", (name, withArticle) => {
    expect(sentence(buildCluePromptParts(madrid, nationality(name)))).toBe(
      `Find a player who played for Real Madrid and is from ${withArticle}`
    );
  });

  it.each(["Serbia", "Spain", "France", "Lithuania"])(
    "uses no article for %s",
    (name) => {
      expect(sentence(buildCluePromptParts(madrid, nationality(name)))).toBe(
        `Find a player who played for Real Madrid and is from ${name}`
      );
    }
  );
});

describe("buildCluePromptParts — robustness", () => {
  const allAxes = [
    virtus,
    madrid,
    nationality("Serbia"),
    nationality("United States of America"),
    playedWith("Vasilije Mičić"),
    season("2015/16"),
    position("Center"),
    champion(),
    milestone("15+ PPG season"),
    milestone("1,000+ career points"),
    milestone("30+ points in a game"),
    milestone("6+ RPG season"),
    milestone("5+ APG season"),
    milestone("15+ PIR season"),
    milestone("3,000+ career points"),
  ];

  it("never produces a blank emphasised clue or a raw team code, for any pairing", () => {
    for (const row of allAxes) {
      for (const col of allAxes) {
        const parts = buildCluePromptParts(row, col);
        const text = sentence(parts);
        // Always a full sentence.
        expect(text.startsWith("Find a player who ")).toBe(true);
        // No empty bold slots.
        for (const value of strongs(parts)) {
          expect(value.trim().length).toBeGreaterThan(0);
        }
        // No raw upstream codes leak in.
        expect(text).not.toContain("VIR");
        expect(text).not.toContain("RMB");
        // No double spaces from concatenating parts.
        expect(text).not.toMatch(/\s{2,}/);
      }
    }
  });

  it("renders an unknown axis type without blanks", () => {
    const parts = buildCluePromptParts(
      { axis_type: "future_type", value: "x", display_label: "Something New" },
      madrid
    );
    expect(sentence(parts)).toBe(
      "Find a player who matches Something New and played for Real Madrid"
    );
  });

  it("degrades gracefully when axes are missing (defensive, should not occur)", () => {
    expect(() => buildCluePromptParts(null, undefined)).not.toThrow();
    const parts = buildCluePromptParts(null, undefined);
    expect(sentence(parts)).toBe(
      "Find a player who matches this clue and matches this clue"
    );
  });
});

describe("buildCluePromptParts — missing labels on known axes (hardening)", () => {
  const noBlankStrongs = (parts) => {
    for (const value of strongs(parts)) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  };

  it("never emits a blank slot when a team axis has no label", () => {
    const labellessTeam = { axis_type: "team", value: "1", team_code: "VIR" };
    const parts = buildCluePromptParts(labellessTeam, nationality("Serbia"));
    noBlankStrongs(parts);
    expect(sentence(parts)).toBe(
      "Find a player who matches this clue and is from Serbia"
    );
    // The raw code must never leak even on the degraded path.
    expect(sentence(parts)).not.toContain("VIR");
  });

  it("does not claim a same-season join when the season axis has no label", () => {
    const labellessSeason = { axis_type: "season", value: "5" };
    const parts = buildCluePromptParts(labellessSeason, madrid);
    noBlankStrongs(parts);
    // Falls back to the independent form rather than "in the  season".
    expect(sentence(parts)).toBe(
      "Find a player who matches this clue and played for Real Madrid"
    );
    expect(sentence(parts)).not.toMatch(/in the\s+season/);
  });

  it("does not use the both-team phrasing when one team has no label", () => {
    const labellessTeam = { axis_type: "team", value: "9" };
    const parts = buildCluePromptParts(labellessTeam, madrid);
    noBlankStrongs(parts);
    expect(sentence(parts)).toBe(
      "Find a player who matches this clue and played for Real Madrid"
    );
    expect(sentence(parts)).not.toContain("played for both");
  });

  it("keeps the champion fallback even with no label", () => {
    const labellessChampion = { axis_type: "champion", value: "euroleague_champion" };
    const parts = buildCluePromptParts(labellessChampion, madrid);
    noBlankStrongs(parts);
    expect(sentence(parts)).toBe(
      "Find a player who was a EuroLeague champion and played for Real Madrid"
    );
  });
});
