// Token-driven-restyle guard for the shared UI component library (TM-511). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`. Mirrors
// theme-tokens.test.mjs (TM-510): it parses the REAL stylesheet + gallery script and asserts the
// contract rather than rendered pixels.
//
// It locks the two hardest ACs:
//   • "Components consume tokens only (no hard-coded values); they restyle when the theme flips."
//     → the `.tm-c-*` block contains NO hard-coded colours (no hex / rgb / hsl) and every component
//       class reads its colour/shape from a `var(--token)`. So flipping the theme (which only swaps
//       token values) restyles every component with zero component edits.
//   • "A gallery page renders every component for visual review."
//     → gallery.js has a render builder for every id in the COMPONENTS catalogue.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { COMPONENTS } from "../src/assets/components-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");
const GALLERY_JS = readFileSync(join(HERE, "../src/assets/gallery.js"), "utf8");

/** Slice out just the TM-511 component-library block, delimited by its banner comments. */
function componentBlock() {
  const start = CSS.indexOf("Shared UI component library (TM-511)");
  const end = CSS.indexOf("end component library (TM-511)");
  assert.ok(start !== -1 && end !== -1 && end > start, "the TM-511 component block must be present + delimited");
  return CSS.slice(start, end);
}

const BLOCK = componentBlock();

test("every component in the catalogue has a `.tm-c-*` rule in the stylesheet", () => {
  // The base classes each component + variant renders to (matching the design-kit paper tiles).
  const required = [
    ".tm-c-btn",
    ".tm-c-btn--ghost",
    ".tm-c-btn--danger",
    ".tm-c-btn--soon",
    ".tm-c-tag",
    ".tm-c-pill",
    ".tm-c-pill--full",
    ".tm-c-chip",
    ".tm-c-chip--selected",
    ".tm-c-input",
    ".tm-c-seg",
    ".tm-c-seg__opt",
    ".tm-c-seg__opt--on",
    ".tm-c-toggle",
    ".tm-c-toggle__thumb",
    ".tm-c-toggle--on",
    ".tm-c-progress",
    ".tm-c-progress__fill",
    ".tm-c-badge",
    ".tm-c-dot",
    ".tm-c-dot--read",
    ".tm-c-avatar",
    ".tm-c-reaction",
    ".tm-c-ticks",
    ".tm-c-modal",
    ".tm-c-sheet",
    ".tm-c-sheet__handle",
  ];
  for (const sel of required) {
    assert.ok(BLOCK.includes(`${sel}`), `styles.css is missing a rule for ${sel}`);
  }
});

test("the component block has NO hard-coded colours — every colour comes from a token (AC2)", () => {
  // Strip comments first so a hex mentioned in prose can't create a false negative (there are none,
  // but be robust). Then assert zero hex / rgb / hsl / oklch colour literals remain.
  const code = BLOCK.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal((code.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 0, "no hex colour literals allowed");
  assert.equal((code.match(/\brgba?\(/g) || []).length, 0, "no rgb()/rgba() colour literals allowed");
  assert.equal((code.match(/\bhsla?\(/g) || []).length, 0, "no hsl()/hsla() colour literals allowed");
  assert.equal((code.match(/\boklch\(/g) || []).length, 0, "no oklch() colour literals allowed");
});

test("the components read their colour + shape from the reconciled tokens (TM-510)", () => {
  // A representative set of tokens the components must consume so a theme flip re-skins them.
  for (const token of [
    "var(--accent)",
    "var(--on-accent)",
    "var(--fg)",
    "var(--surface-card)",
    "var(--surface-2)",
    "var(--muted)",
    "var(--danger)",
    "var(--fg-line)",
    "var(--border-width)",
    "var(--radius-pill)",
    "var(--radius-lg)",
    "var(--shadow-lg)",
    "var(--space-2)",
    "var(--fs-2)",
  ]) {
    assert.ok(BLOCK.includes(token), `the component library must consume ${token}`);
  }
});

test("the accent fill is paired with on-accent text (contrast survives every theme)", () => {
  // Wherever a component fills with the accent it must set text to --on-accent, so the label stays
  // legible under clean (coloured accent) AND sketch (graphite accent). Guards the reconciliation.
  assert.match(BLOCK, /\.tm-c-btn\s*\{[^}]*color:\s*var\(--on-accent\)/s);
  assert.match(BLOCK, /\.tm-c-chip--selected\s*\{[^}]*color:\s*var\(--on-accent\)/s);
  assert.match(BLOCK, /\.tm-c-seg__opt--on\s*\{[^}]*color:\s*var\(--on-accent\)/s);
  assert.match(BLOCK, /\.tm-c-badge\s*\{[^}]*color:\s*var\(--on-accent\)/s);
});

test("the bottom sheet folds the bottom safe-area inset into its own padding (TM-533)", () => {
  // The `.tm-c-sheet-backdrop` override zeroes `.tm-backdrop`'s inset-aware padding so the full-width
  // sheet sits flush to the bottom edge — which also strips the `env(safe-area-inset-bottom)` that keeps
  // a centred `.tm-c-modal` clear of the home indicator. So the bottom-anchored sheet must carry the
  // inset in its OWN bottom padding, or its action buttons (e.g. "Block this person") render under the
  // home indicator under the shell's `viewport-fit=cover` (the TM-295 convention).
  const backdrop = BLOCK.match(/\.tm-c-sheet-backdrop\s*\{([^}]*)\}/);
  assert.ok(backdrop, "the sheet backdrop rule must be present");
  assert.match(backdrop[1], /padding:\s*0\b/, "the sheet backdrop still zeroes the shared inset padding");

  // Grab the standalone `.tm-c-sheet` rule — the one that declares padding, not the shared group rule
  // (`.tm-c-modal, .tm-c-sheet`) nor the `__handle` / `-backdrop` selectors.
  const sheet = BLOCK.match(/\.tm-c-sheet\s*\{([^}]*padding[^}]*)\}/);
  assert.ok(sheet, "the standalone .tm-c-sheet rule (with padding) must be present");
  assert.match(
    sheet[1],
    /padding:[^;]*env\(safe-area-inset-bottom\)/,
    "the sheet's bottom padding must fold in env(safe-area-inset-bottom) so it clears the home indicator",
  );
});

test("the gallery renders every catalogued component (AC3)", () => {
  // gallery.js keys its render builders by component id; assert one exists for each catalogue entry
  // so a component can never be added without a visible-review tile.
  for (const c of COMPONENTS) {
    // matches either  buttons: () =>   or  "tags-pills": () =>
    const re = new RegExp(`["']?${c.id.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}["']?\\s*:\\s*\\(`);
    assert.match(GALLERY_JS, re, `gallery.js is missing a render builder for "${c.id}"`);
  }
});
