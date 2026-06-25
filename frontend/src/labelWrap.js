// Mobile word-break guard for TicTacToe axis labels (the row/column header
// chips rendered by AxisLabel). On narrow viewports (<=390px) the grid tracks
// are only ~50-73px wide, so a long single word is force-broken by
// `overflow-wrap: break-word` and can strand a single trailing letter, e.g.
// "Olympiacos" -> "Olympiaco" / "s". That lone letter reads as broken layout.
//
// Empirically (DM Sans, real Chromium layout at the ~50px narrowest inner
// width) orphaning starts at 9-character words (Barcelona -> "a",
// Spanoulis -> "s"); 8-character tokens still fit on one line. Keeping the last
// two characters of the trailing word unbreakable guarantees a forced break can
// never leave a lone letter (the last line always has >=2 chars), without
// changing the font size or touching desktop sizing.
//
// We gate at minWord = 8 (one char below the observed 9-char threshold) so the
// real 8-char terminal words ("EuroLeague champion", "Zalgiris", "Valencia")
// are also protected at sub-320px foldable widths and to leave headroom for the
// largely-untested iOS Safari fleet whose font metrics differ from Chromium.
// Short labels (Guard / Real Madrid / "season") stay untouched.
export function splitTrailingGroup(label, { minWord = 8, keep = 2 } = {}) {
  if (typeof label !== "string") return { head: label, tail: "" };
  const trimmed = label.trimEnd();
  const lastWord = trimmed.split(/\s+/).pop() ?? "";
  // Code-point aware (Array.from) so a surrogate pair or precomposed accent is
  // never split mid-glyph; EuroLeague names like "Fenerbahce" stay intact.
  const lastWordChars = Array.from(lastWord);
  const labelChars = Array.from(trimmed);
  if (lastWordChars.length < minWord || labelChars.length <= keep) {
    return { head: label, tail: "" };
  }
  const head = labelChars.slice(0, labelChars.length - keep).join("");
  const tail = labelChars.slice(labelChars.length - keep).join("");
  return { head, tail };
}
