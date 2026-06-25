import { describe, it, expect } from "vitest";
import { splitTrailingGroup } from "../labelWrap";

// splitTrailingGroup keeps the last two characters of a long label's trailing
// word unbreakable so the narrow TicTacToe grid tracks can't strand a single
// letter on the last line (#265). These tests lock the pure contract; the
// visual proof lives in the empirical Chromium harness, not jsdom.

describe("splitTrailingGroup", () => {
  it("does not split short single-word labels", () => {
    for (const label of ["Guard", "Forward", "Center", "Monaco", "Bologna"]) {
      expect(splitTrailingGroup(label)).toEqual({ head: label, tail: "" });
    }
  });

  it("protects the last two characters of a long single word", () => {
    expect(splitTrailingGroup("Olympiacos")).toEqual({
      head: "Olympiac",
      tail: "os",
    });
  });

  it("protects words at the reported orphan length (9 chars)", () => {
    expect(splitTrailingGroup("Barcelona")).toEqual({ head: "Barcelo", tail: "na" });
    expect(splitTrailingGroup("Spanoulis")).toEqual({ head: "Spanoul", tail: "is" });
  });

  it("protects exactly 8-character words but leaves 7-character words intact", () => {
    // 8 is the gate: one char below the empirically observed 9-char orphan, for
    // foldable / iOS-Safari headroom.
    expect(splitTrailingGroup("Zalgiris")).toEqual({ head: "Zalgir", tail: "is" });
    expect(splitTrailingGroup("Valencia")).toEqual({ head: "Valenc", tail: "ia" });
    expect(splitTrailingGroup("Madrid")).toEqual({ head: "Madrid", tail: "" });
  });

  it("only considers the trailing word, not the whole label", () => {
    // Short last word => no split even though the label is long.
    expect(splitTrailingGroup("Maccabi Tel Aviv")).toEqual({
      head: "Maccabi Tel Aviv",
      tail: "",
    });
    // Long terminal word => split just its tail, head keeps the leading words.
    expect(splitTrailingGroup("Hapoel Jerusalem")).toEqual({
      head: "Hapoel Jerusal",
      tail: "em",
    });
  });

  it("leaves a non-terminal long word unsplit (out of scope: trailing letter only)", () => {
    // "Fortitudo" is long but first; the label already wraps cleanly at the
    // space, so issue #265 (a stranded *trailing* letter) does not apply.
    expect(splitTrailingGroup("Fortitudo Bologna")).toEqual({
      head: "Fortitudo Bologna",
      tail: "",
    });
  });

  it("splits on code points so precomposed accents stay intact", () => {
    const result = splitTrailingGroup("Fenerbah\u00e7e");
    expect(result).toEqual({ head: "Fenerbah", tail: "\u00e7e" });
    expect(result.head + result.tail).toBe("Fenerbah\u00e7e");
  });

  it("preserves the full string across head + tail for protected labels", () => {
    for (const label of ["Olympiacos", "Panathinaikos", "Darussafaka", "Galatasaray"]) {
      const { head, tail } = splitTrailingGroup(label);
      expect(head + tail).toBe(label);
      expect(Array.from(tail).length).toBe(2);
    }
  });

  it("handles empty, placeholder, and non-string input safely", () => {
    expect(splitTrailingGroup("")).toEqual({ head: "", tail: "" });
    expect(splitTrailingGroup("\u2014")).toEqual({ head: "\u2014", tail: "" });
    expect(splitTrailingGroup(undefined)).toEqual({ head: undefined, tail: "" });
    expect(splitTrailingGroup(null)).toEqual({ head: null, tail: "" });
  });

  it("honours custom minWord / keep options", () => {
    expect(splitTrailingGroup("Bologna", { minWord: 7, keep: 3 })).toEqual({
      head: "Bolo",
      tail: "gna",
    });
  });
});
