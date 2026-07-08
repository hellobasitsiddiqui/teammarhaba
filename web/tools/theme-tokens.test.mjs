// Design-token contract guard (TM-510). Framework-free — Node's built-in test runner, picked up by
// the CI glob `node --test web/tools/*.test.mjs`.
//
// TM-510 reconciled the shipped theme tokens with the approved wireframe kit into ONE authoritative
// token set (see docs/design/design-tokens.md). This test locks that contract so a later edit can't
// silently reintroduce drift: it parses the real stylesheet (web/src/assets/styles.css) and asserts
//   • the design-kit PRIMITIVES exist on :root with the kit's anchor values (ramp, spacing, type),
//   • the semantic additions exist (--accent-light, --shadow-card),
//   • the `sketch` (default) + `doodle` families RESOLVE FROM that single set (alias the ramp / the
//     type-scale faces) rather than re-hard-coding hexes or font stacks, and
//   • no screen re-introduces the hard-coded card shadow / white the reconciliation tokenised (AC3).
// It asserts the token *contract*, not exact pixels (the e2e theme-visual spec covers rendering).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");

/** Count non-overlapping occurrences of a literal substring in the stylesheet. */
function count(needle) {
  return CSS.split(needle).length - 1;
}

test("the neutral/ink primitive ramp is defined with the kit's anchor values", () => {
  // The grayscale ramp the wireframe kit is built on. The anchor values (--white/--g1/--g2/--g5/--ink)
  // are the exact greys the sketch theme renders, so the alias is byte-for-byte (no visual change).
  const ramp = {
    "--white": "#ffffff",
    "--g1": "#fafafa",
    "--g2": "#f0f0f0",
    "--g3": "#e0e0e0",
    "--g4": "#c4c4c4",
    "--g5": "#6a6a6a",
    "--g6": "#3a3a3a",
    "--ink": "#2b2b2b",
  };
  for (const [name, value] of Object.entries(ramp)) {
    assert.match(CSS, new RegExp(`${name}:\\s*${value};`), `${name} must be defined as ${value}`);
  }
});

test("the spacing scale (--space-1..7) is defined", () => {
  const spacing = ["0.25rem", "0.5rem", "0.75rem", "1rem", "1.5rem", "2rem", "3rem"];
  spacing.forEach((value, i) => {
    assert.match(CSS, new RegExp(`--space-${i + 1}:\\s*${value};`), `--space-${i + 1} must be ${value}`);
  });
});

test("the type scale (font faces + size steps) is defined", () => {
  for (const name of ["--font-display", "--font-accent", "--fs-1", "--fs-3", "--fs-6", "--fs-hero"]) {
    assert.ok(CSS.includes(`${name}:`), `${name} must be defined`);
  }
  // The hero step is the landing wordmark size and the wordmark must READ it (not a raw 2.5rem).
  assert.match(CSS, /--fs-hero:\s*2\.5rem;/);
  assert.match(CSS, /\.app h1[^}]*font-size:\s*var\(--fs-hero\);/s, ".app h1 must use var(--fs-hero)");
  assert.equal(count("font-size: 2.5rem"), 0, "the raw 2.5rem hero size must be tokenised");
});

test("the reconciliation's new semantic tokens exist", () => {
  assert.match(CSS, /--accent-light:\s*color-mix\(/, "--accent-light must be defined");
  assert.match(CSS, /--shadow-card:\s*0 6px 24px rgba\(0, 0, 0, 0\.06\);/, "--shadow-card must be defined");
});

test("no hard-coded card shadow or white drift remains (AC3)", () => {
  // The soft card shadow previously lived as a raw literal in 3 card rules; it must now exist ONLY as
  // the --shadow-card token definition (one occurrence), everything else references var(--shadow-card).
  assert.equal(
    count("0 6px 24px rgba(0, 0, 0, 0.06)"),
    1,
    "the card shadow must appear once (the --shadow-card def); cards must use var(--shadow-card)",
  );
  assert.ok(count("box-shadow: var(--shadow-card);") >= 3, "the 3 cards must reference var(--shadow-card)");
  // The toggle thumb's hard-coded white was tokenised to var(--white).
  assert.equal(count("background: #fff;"), 0, "no bare `background: #fff;` — use var(--white)/--surface-card");
});

test("the sketch family resolves its neutrals from the single ramp (not re-hard-coded hexes)", () => {
  // These aliases appear only in the [data-theme="sketch"] block; they prove the default wireframe
  // theme reads the primitive ramp rather than duplicating grey hexes (the drift TM-510 removed).
  for (const decl of [
    "--fg: var(--ink);",
    "--accent: var(--ink);",
    "--page-bg: var(--g1);",
    "--surface: var(--g1);",
    "--surface-2: var(--g2);",
    "--surface-card: var(--white);",
    "--muted: var(--g5);",
  ]) {
    assert.ok(CSS.includes(decl), `sketch must alias the ramp: expected \`${decl}\``);
  }
});

test("doodle + sketch resolve their faces from the type-scale tokens", () => {
  // Both wireframe families define the display/accent faces once as tokens, and the heading/tagline
  // rules read them via var() — so the hand faces have a single source per theme (no repeated stacks).
  assert.equal(count('--font-display: "Gochi Hand"'), 2, "doodle + sketch each define --font-display");
  assert.equal(count('--font-accent: "Shadows Into Light"'), 2, "doodle + sketch each define --font-accent");
  assert.equal(count("font-family: var(--font-display);"), 2, "both heading rules read var(--font-display)");
  assert.equal(count("font-family: var(--font-accent);"), 2, "both tagline rules read var(--font-accent)");
  // The old duplicated literal font stacks in font-family rules are gone.
  assert.equal(count('font-family: "Gochi Hand"'), 0, "no literal Gochi Hand font-family rule remains");
  assert.equal(count('font-family: "Shadows Into Light"'), 0, "no literal Shadows Into Light font-family rule remains");
});

test("clean is the base contract: --font-display/--font-accent default to the body face on :root", () => {
  assert.match(CSS, /--font-display:\s*var\(--font-sans\);/, "clean --font-display aliases the body face");
  assert.match(CSS, /--font-accent:\s*var\(--font-sans\);/, "clean --font-accent aliases the body face");
});
