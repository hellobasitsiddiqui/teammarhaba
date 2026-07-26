// TM-1083 — the profile bottom actions (Notifications / Public profile / Privacy & my data / Sign out)
// must render as standalone button-CARDS matching the collapsible section headers, NOT a divided list.
// Guard test: pins the markup (nav rendered directly, no wrapping menu-card) + the card CSS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const profileJs = readFileSync(join(HERE, "../src/assets/profile.js"), "utf8");
const css = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");

// Extract the .tm-pf-menu-row rule block.
const rowBlock = (css.match(/\.tm-pf-menu-row\s*\{[^}]*\}/s) || [""])[0];

test("TM-1083: the actions nav is rendered directly, NOT wrapped in a menu-card (each row is its own card)", () => {
  // The old divided-list wrapper class is gone from both the markup and the stylesheet.
  assert.ok(!profileJs.includes("tm-pf-menu-card"), "the wrapping .tm-pf-menu-card should be gone from profile.js");
  assert.ok(!css.includes(".tm-pf-menu-card"), "the .tm-pf-menu-card CSS rule should be removed");
  // The menu is still a labelled nav (a11y preserved).
  assert.match(profileJs, /class:\s*"tm-pf-menu"[^]*?"aria-label":\s*"Profile menu"/, "the Profile menu nav must remain");
});

test("TM-1083: each .tm-pf-menu-row is a standalone button-card (rounded + bordered), not a divided-list row", () => {
  assert.ok(rowBlock, ".tm-pf-menu-row rule must exist");
  assert.match(rowBlock, /border-radius:/, "a card has a border-radius");
  assert.match(rowBlock, /box-shadow:/, "a card has a shadow like the section headers");
  assert.match(rowBlock, /border:\s*var\(--border-width\)/, "a card has a full border, not just a bottom edge");
  // The divider that made it read as a table must be gone.
  assert.ok(!/border-bottom/.test(rowBlock), "no border-bottom divider — that's the divided-list look we removed");
  // Tap-accessibility floor, matching the section headers.
  assert.match(rowBlock, /min-height:\s*44px/, "≥44px tap target");
});
