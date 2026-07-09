// Design-token contract guard (TM-510, updated for the single Paper theme in TM-529). Framework-free —
// Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// TM-510 reconciled the shipped theme tokens with the approved wireframe kit into ONE authoritative
// token set (docs/design/design-tokens.md). TM-529 then RETIRED the multi-theme family system
// (clean/doodle/sketch) — Paper is now the single theme, folded onto :root, with a per-user accent
// (a fixed curated palette) and a `[data-sketchy]` on/off wavy toggle. This test locks the new
// contract so a later edit can't silently reintroduce a second theme or drift the tokens:
//   • the design-kit PRIMITIVES exist on :root with the kit's anchor values (ramp, spacing, type),
//   • the Paper base (:root) RESOLVES its neutrals from that ramp (aliases, not re-hard-coded hexes),
//   • the curated accent palette exists as `--accent-paper-*` tokens and `--accent` defaults to teal,
//   • the hand-lettered faces are the single Paper type contract,
//   • there is NO `[data-theme=...]` family selector left and no retired theme name is selectable, and
//   • the wavy/sketchy skin lives on `[data-sketchy="on"]` (wobble filter + ruled grid).
// It asserts the token *contract*, not exact pixels (the e2e appearance-visual spec covers rendering).

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
  // The grayscale ramp the wireframe kit is built on — Paper resolves its neutrals from these.
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

test("the type scale (size steps) is defined and the hero size is tokenised", () => {
  for (const name of ["--font-display", "--font-accent", "--fs-1", "--fs-3", "--fs-6", "--fs-hero"]) {
    assert.ok(CSS.includes(`${name}:`), `${name} must be defined`);
  }
  assert.match(CSS, /--fs-hero:\s*2\.5rem;/);
  assert.match(CSS, /\.app h1[^}]*font-size:\s*var\(--fs-hero\);/s, ".app h1 must use var(--fs-hero)");
  assert.equal(count("font-size: 2.5rem"), 0, "the raw 2.5rem hero size must be tokenised");
});

test("the reconciliation's new semantic tokens exist", () => {
  assert.match(CSS, /--accent-light:\s*color-mix\(/, "--accent-light must be defined");
  assert.match(CSS, /--shadow-card:\s*0 6px 24px rgba\(0, 0, 0, 0\.06\);/, "--shadow-card must be defined");
});

test("no hard-coded card shadow or white drift remains (TM-510 AC3)", () => {
  assert.equal(
    count("0 6px 24px rgba(0, 0, 0, 0.06)"),
    1,
    "the card shadow must appear once (the --shadow-card def); cards must use var(--shadow-card)",
  );
  assert.ok(count("box-shadow: var(--shadow-card);") >= 3, "the 3 cards must reference var(--shadow-card)");
  assert.equal(count("background: #fff;"), 0, "no bare `background: #fff;` — use var(--white)/--surface-card");
});

test("Paper is the single theme: NO retired theme family is selectable (TM-529 AC1)", () => {
  // The whole `data-theme` family axis is gone — there is no clean/doodle/sketch selector left, so no
  // non-Paper theme can be selected via CSS. (Prose mentions in comments are fine; a live selector is
  // not — this counts the selector token, which only appears in a rule.)
  assert.equal(count("[data-theme"), 0, "no [data-theme=...] selector may remain (Paper is the sole theme)");
  assert.equal(count('data-theme="clean"'), 0, "the clean theme must be fully removed");
  assert.equal(count('data-theme="doodle"'), 0, "the doodle theme must be fully removed");
  assert.equal(count('data-theme="sketch"'), 0, "the sketch theme must be fully removed");
});

test("the Paper base (:root) resolves its neutrals from the single ramp (not re-hard-coded hexes)", () => {
  // Paper is folded onto :root and aliases the primitive ramp — the drift TM-510 removed stays removed.
  for (const decl of [
    "--fg: var(--ink);",
    "--page-bg: var(--g1);",
    "--surface: var(--g1);",
    "--surface-2: var(--g2);",
    "--surface-card: var(--white);",
    "--muted: var(--g5);",
  ]) {
    assert.ok(CSS.includes(decl), `Paper base must alias the ramp: expected \`${decl}\``);
  }
  // Paper's inky lines are 2px (the wireframe-kit weight), not the old 1px clean border.
  assert.match(CSS, /--border-width:\s*2px;/, "Paper border-width must be 2px");
});

test("the curated accent palette exists as tokens and --accent defaults to the teal swatch (TM-529)", () => {
  const palette = {
    "--accent-paper-teal": "#0f9d8c",
    "--accent-paper-indigo": "#4f46e5",
    "--accent-paper-coral": "#d1495b",
    "--accent-paper-amber": "#b45309",
    "--accent-paper-plum": "#7c3aed",
    "--accent-paper-ink": "#2b2b2b",
  };
  for (const [name, value] of Object.entries(palette)) {
    assert.match(CSS, new RegExp(`${name}:\\s*${value};`), `curated swatch ${name} must be ${value}`);
  }
  // The default swatch (teal) IS the shipped --accent, so a new user gets it with no override.
  assert.match(CSS, /--accent:\s*var\(--accent-paper-teal\);/, "--accent must default to the teal swatch");
});

test("the hand-lettered faces are the single Paper type contract (on :root, read via var())", () => {
  // Exactly ONE definition of each hand face (on :root — Paper is the only theme now), and the
  // heading/tagline rules read them via var() rather than re-hard-coding a font stack.
  assert.equal(count('--font-display: "Gochi Hand"'), 1, ":root defines --font-display once");
  assert.equal(count('--font-accent: "Shadows Into Light"'), 1, ":root defines --font-accent once");
  // At least one consumer reads each face via var() (the heading + the tagline rules). This was `=== 1`
  // but the boot screen (TM-381) legitimately adds a second consumer of BOTH — its wordmark reads the
  // display face and its launch tagline reads the accent face — so the contract is "read via var(), 1+
  // consumers", not "exactly one element". The single-definition (above) + no-literal-stack (below)
  // guards still lock the real contract: no second theme, no re-hard-coded font stack.
  assert.ok(count("font-family: var(--font-display);") >= 1, "heading/wordmark rules read var(--font-display)");
  assert.ok(count("font-family: var(--font-accent);") >= 1, "tagline rules read var(--font-accent)");
  // No duplicated literal font stacks in font-family rules.
  assert.equal(count('font-family: "Gochi Hand"'), 0, "no literal Gochi Hand font-family rule remains");
  assert.equal(count('font-family: "Shadows Into Light"'), 0, "no literal Shadows Into Light font-family rule remains");
});

test("the wavy/sketchy skin lives on [data-sketchy=\"on\"] (TM-529 AC3)", () => {
  // The wobble filter + doodles are the hand-drawn layer, gated on the per-user toggle. (The ruled
  // graph-paper grid was DROPPED from the default look in TM-552 — owner request; wobble + doodles remain.)
  assert.ok(count('[data-sketchy="on"]') >= 5, "the sketchy skin must be scoped to [data-sketchy=\"on\"]");
  assert.match(
    CSS,
    /\[data-sketchy="on"\][^{]*\{\s*filter:\s*url\("#wobble-soft"\)/s,
    "the wobble filter must apply under [data-sketchy=\"on\"]",
  );
  assert.equal(
    count("repeating-linear-gradient"),
    0,
    "the ruled-paper grid was removed (TM-552) — no repeating-linear-gradient should remain",
  );
  // Clean Paper hides the decorative doodles; sketchy shows them.
  assert.match(CSS, /:root:not\(\[data-sketchy="on"\]\) \.tm-doodle/, "doodles hide in clean Paper");
});
