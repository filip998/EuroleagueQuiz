import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import GameSetupShell from "../GameSetupShell.jsx";
import GameResult from "../GameResult.jsx";

// Guards issue #293: the fixed account controls (`AuthMenu`, top-3 right-3) must
// never cover game UI. The fix is a shared, decoupled "reserved top safe-area"
// contract: a `--elq-auth-safe-top` CSS var (0px by default, non-zero only when
// `html[data-auth-chrome="reserve"]` is set by main.jsx when Clerk is enabled),
// consumed app-wide via the `.elq-auth-safe-top` utility on each screen's root.
// These tests pin both halves of the contract so anonymous builds stay identical
// (var defaults to 0) and a screen root can never silently drop the reserve.

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..");
const css = readFileSync(resolve(srcDir, "index.css"), "utf8");

describe("auth safe-area CSS contract (issue #293)", () => {
  it("defaults the reserve to 0px on :root so anonymous builds are unchanged", () => {
    expect(css).toMatch(/:root\s*\{[^}]*--elq-auth-safe-top:\s*0px\s*;/);
  });

  it("reserves a non-zero top band only when data-auth-chrome=reserve is set", () => {
    const match = css.match(
      /html\[data-auth-chrome="reserve"\]\s*\{\s*--elq-auth-safe-top:\s*([^;]+);/
    );
    expect(match).not.toBeNull();
    // The reserve must be a positive, non-zero length (rem) so it actually
    // clears the controls; 0/0px would defeat the fix.
    expect(match[1].trim()).toMatch(/^[1-9]/);
    expect(match[1].trim()).not.toMatch(/^0(px|rem)?$/);
  });

  it("exposes a .elq-auth-safe-top utility that consumes the reserve as top padding", () => {
    expect(css).toMatch(
      /\.elq-auth-safe-top\s*\{\s*padding-top:\s*var\(--elq-auth-safe-top[^)]*\)\s*;/
    );
  });
});

describe("shared screen roots reserve the auth safe-area (issue #293)", () => {
  it("GameSetupShell's outermost root carries the reserve utility", () => {
    const { container } = render(
      <GameSetupShell title="Test" tagline="Tagline" icon={<svg />}>
        <div>body</div>
      </GameSetupShell>
    );
    expect(container.firstChild).toHaveClass("elq-auth-safe-top");
  });

  it("GameResult's outermost root carries the reserve utility", () => {
    const { container } = render(<GameResult title="GAME OVER" />);
    expect(container.firstChild).toHaveClass("elq-auth-safe-top");
  });
});

describe("every full-screen game root opts into the reserve (issue #293)", () => {
  // Each of these renders a top-level screen whose outermost root could sit under
  // the fixed account controls, so each must carry `.elq-auth-safe-top`. A
  // source scan keeps the guarantee from silently regressing if a root is
  // refactored. (Transient centered spinners are intentionally excluded: their
  // content is centered, never in the top-right, so they can't be covered.)
  const files = [
    "App.jsx",
    "GameBoard.jsx",
    "GameSetupShell.jsx",
    "GameResult.jsx",
    "CareerQuizBoard.jsx",
    "PhotoQuizBoard.jsx",
    "HigherLowerBoard.jsx",
    "GuessTheListBoard.jsx",
    "GuessTheListRaceBoard.jsx",
    "auth.jsx",
  ];

  for (const file of files) {
    it(`${file} applies the elq-auth-safe-top reserve`, () => {
      const content = readFileSync(resolve(srcDir, file), "utf8");
      expect(content).toMatch(/className="elq-auth-safe-top /);
    });
  }
});
