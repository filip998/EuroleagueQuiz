import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve, join, relative } from "path";

// Guards issue #260: the primary orange CTA must clear WCAG AA. White text on the
// brand orange (#FF6600) is only 2.94:1; the accessible CTA fill token #C2410C is
// 5.18:1 (resting) and #9A3412 is 7.31:1 (hover). Any solid-orange surface carrying
// white text must use the CTA token (`bg-elq-cta`/`hover:bg-elq-cta-dark`), never the
// decorative brand orange (`bg-elq-orange*`).

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..");
const css = readFileSync(resolve(srcDir, "index.css"), "utf8");

describe("accessible CTA token (issue #260)", () => {
  it("defines the accessible CTA fill colours in @theme so both UI variants pass AA", () => {
    expect(css).toMatch(/--color-elq-cta:\s*#C2410C\s*;/);
    expect(css).toMatch(/--color-elq-cta-dark:\s*#9A3412\s*;/);
  });

  it("keeps the brand orange unchanged for decorative accents", () => {
    expect(css).toMatch(/--color-elq-orange:\s*#FF6600\s*;/);
    expect(css).toMatch(/--color-elq-orange-dark:\s*#E85D00\s*;/);
  });
});

function collectSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "test") continue; // tests legitimately reference the classes
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// A solid orange background fill is `bg-elq-orange`, `bg-elq-orange-dark`, or
// `bg-elq-orange-light` — i.e. `bg-elq-orange` NOT followed by `/` (the `/opacity`
// variants like `bg-elq-orange/10` are decorative tints and are allowed).
const SOLID_ORANGE_BG = /bg-elq-orange(?!\/)/;

// Tailwind utility classes always live inside a string or template literal, so we
// scan each literal independently. This catches an offender even when the
// className wraps across multiple lines (template literals can span lines) while
// never false-positiving a decorative solid `bg-elq-orange` that sits in a
// different literal than any `text-white`.
const STRING_LITERAL = /"[^"]*"|'[^']*'|`[^`]*`/g;

describe("no white text on solid brand orange (issue #260)", () => {
  const files = collectSourceFiles(srcDir);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds no string literal pairing a solid orange background with white text", () => {
    const offenders = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const literal of content.match(STRING_LITERAL) || []) {
        if (SOLID_ORANGE_BG.test(literal) && literal.includes("text-white")) {
          offenders.push(relative(srcDir, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
