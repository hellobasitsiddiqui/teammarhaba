// Corner-bell chrome tests (TM-910 → TM-1043). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE CHANGE (TM-1043): the top .app-nav (hamburger + account links) is deleted; the notification
// bell is now standalone fixed chrome (#app-topbar, index.html) pinned top-right of the app clamp
// band by static CSS on EVERY route. The old per-route CORNER_BELL_ROUTES decision is retired, so:
//   (1) the pure rule bellPinnedToCorner() is TRUE for every real route (fail-safe false on junk) —
//       any future re-introduction of route-scoped bell chrome must consciously edit rule + test;
//   (2) the DOM bridge updateCornerBell() is a deliberate no-op that must NEVER query the DOM —
//       the nav/toggle elements it used to move no longer exist and must not be resurrected;
//   (3) router.js's render() still drives the seam (source-level assert, like
//       shell-brand-core.test.mjs — router.js can't be imported under `node --test`: it sits on
//       the api.js → Firebase CDN import chain).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bellPinnedToCorner } from "../src/assets/corner-bell-core.js";
import { updateCornerBell } from "../src/assets/corner-bell.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- (1) the pure rule -------------------------------------------------------------------------------

test("the bell is corner-pinned on EVERY real route (TM-1043 — the .app-nav row is gone)", () => {
  for (const route of [
    "#/profile", "#/profile/public",
    "#/home", "#/home/feed",
    "#/events", "#/events/42",
    "#/login", "#/chat", "#/chat/7",
    "#/admin", "#/admin/events",
    "#/help", "#/notifications", "#/onboarding", "#/terms", "#/diagnostics",
    "#/membership", "#/receipts",
  ]) {
    assert.equal(bellPinnedToCorner(route), true, `expected corner-bell ON for ${route}`);
  }
});

test("fails safe (off) on junk input", () => {
  assert.equal(bellPinnedToCorner(""), false);
  assert.equal(bellPinnedToCorner(null), false);
  assert.equal(bellPinnedToCorner(undefined), false);
  assert.equal(bellPinnedToCorner(42), false);
});

// --- (2) the DOM bridge ------------------------------------------------------------------------------

/**
 * Spy document: records every DOM lookup. The TM-1043 bridge must never query the DOM — the
 * nav.app-nav / #nav-toggle elements it used to relocate are deleted, so ANY lookup here would mean
 * the bridge is resurrecting nav meddling against elements that no longer exist.
 */
function spyDoc() {
  const calls = [];
  return {
    calls,
    querySelector(sel) {
      calls.push(["querySelector", sel]);
      return null;
    },
    getElementById(id) {
      calls.push(["getElementById", id]);
      return null;
    },
  };
}

test("updateCornerBell is a no-op bridge: never throws and NEVER queries the DOM (TM-1043)", () => {
  const doc = spyDoc();
  assert.doesNotThrow(() => updateCornerBell({ route: "#/profile" }, doc));
  assert.doesNotThrow(() => updateCornerBell({ route: "#/chat" }, doc));
  assert.deepEqual(doc.calls, [], "the bridge must not touch the DOM — the .app-nav chrome is gone");
});

test("updateCornerBell tolerates a missing document and junk state without throwing", () => {
  assert.doesNotThrow(() => updateCornerBell({ route: "#/profile" }, null));
  assert.doesNotThrow(() => updateCornerBell(undefined, spyDoc()));
  assert.doesNotThrow(() => updateCornerBell({}, spyDoc()));
});

// --- (3) the router wiring (source-level guard) ------------------------------------------------------

test("router.js render() drives the corner-bell seam (TM-910 wiring, kept through TM-1043)", () => {
  const routerSrc = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");
  assert.match(
    routerSrc,
    /import\s*\{\s*updateCornerBell\s*\}\s*from\s*"\.\/corner-bell\.js"/,
    "router.js imports the corner-bell DOM bridge",
  );
  assert.match(
    routerSrc,
    /updateCornerBell\(\s*\{\s*route\s*\}\s*\)/,
    "render() must call updateCornerBell({ route }) — the router is the single source of truth for shell chrome",
  );
});
