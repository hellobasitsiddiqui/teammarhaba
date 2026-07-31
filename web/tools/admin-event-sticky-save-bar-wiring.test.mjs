// Admin event form — sticky Save action bar wiring guard (TM-1190). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// buildEventForm (admin-events.js) can't be imported in Node (a transitive Firebase `https:` import in
// its api/auth chain isn't resolvable by the default ESM loader), so — like the other admin-event wiring
// guards (admin-event-more-options-wiring.test.mjs / admin-event-edit-image-preview.test.mjs) — the
// structure is asserted against the module + stylesheet source. These fail BEFORE the change (the bar +
// its CSS don't exist) and pass AFTER, so a later edit can't silently:
//   1. drop the sticky action bar wrapper around the reset/cancel/save row,
//   2. move the primary Save button (#event-save) out of that bar,
//   3. drop the CSS that makes the bar sticky + clears the fixed tab bar.
// The Save button's OWN identity (id, create/series/save label logic, submit handler) is left untouched
// by this ticket — this guard only pins the existing row into the new bar.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const JS = readFileSync(join(HERE, "../src/assets/admin-events.js"), "utf8");
const CSS = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");

test("the reset/cancel/save row is wrapped in a sticky action bar (TM-1190)", () => {
  // A dedicated bar node with a stable id/class, holding the existing .tm-form-actions row.
  assert.match(
    JS,
    /class:\s*["']tm-event-actions-bar["']/,
    "the action row must be wrapped in a .tm-event-actions-bar sticky footer",
  );
  assert.match(
    JS,
    /id:\s*["']event-actions-bar["']/,
    "the sticky bar needs a stable id (#event-actions-bar) for the e2e + a11y",
  );
});

test("the primary Save row lives INSIDE the sticky bar (TM-1190)", () => {
  // The bar wraps the same [reset, cancel, save] actions row — Save (#event-save) is pinned, not buried.
  assert.match(
    JS,
    /tm-event-actions-bar["'][^]*?tm-form-actions["'][^]*?\[reset,\s*cancel,\s*save\]/,
    "the [reset, cancel, save] actions row must be nested inside the .tm-event-actions-bar wrapper",
  );
});

test("the Save button itself is unchanged — still #event-save, submit type, label logic (TM-1190)", () => {
  // Guard that this layout-only ticket did NOT touch the button's wiring.
  assert.match(
    JS,
    /el\(\s*["']button["'],\s*\{\s*class:\s*["']tm-btn tm-btn-primary["'],\s*id:\s*["']event-save["'],\s*type:\s*["']submit["']\s*\}/,
    "the primary Save button must keep its id/class/type",
  );
  assert.match(
    JS,
    /mode === "create" \? \(recurrence && recurrence\.isEnabled\(\) \? "Create series" : "Create event"\) : "Save changes"/,
    "the create/series/edit Save label logic must be preserved verbatim",
  );
});

test("styles.css makes the bar sticky + clears the fixed tab bar (TM-1190)", () => {
  // The sticky positioning + the tab-bar clearance are what keep Save reachable without overlapping chrome.
  assert.match(
    CSS,
    /\.tm-event-actions-bar\s*\{[^}]*position:\s*sticky/,
    "the bar must be position: sticky so it pins while scrolling",
  );
  assert.match(
    CSS,
    /body\.tm-has-tabbar\s+\.tm-event-actions-bar\s*\{[^}]*bottom:\s*calc\(4\.75rem\s*\+\s*env\(safe-area-inset-bottom\)\)/,
    "with the tab bar present the sticky bar must lift above it (no overlap with the fixed tab bar)",
  );
});
