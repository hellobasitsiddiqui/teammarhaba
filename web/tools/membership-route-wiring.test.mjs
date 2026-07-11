// Receipts route-wiring regression guard (TM-624 fix, backfilled by TM-629). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG (review finding, frontend-ci MEDIUM): membership-receipts.js (TM-481) shipped with its OWN
// `hashchange` listener + self-init, pre-dating the TM-606 decision that routing goes through
// router.js. router.js didn't know `#/receipts`, so with the membership flag ON:
//   (1) navigating to #/receipts made router's currentRoute() fall through to the auth default HOME —
//       render() showed the home view WHILE the receipts module un-hid its own section: two screens
//       stacked, plus a spurious enterHome() feed fetch on every receipts visit;
//   (2) #/receipts was not in isProtected(), so a signed-out deep link fired GET /me/orders with no
//       token instead of bouncing to login;
//   (3) the module revealed its own nav link at boot, ignoring the signed-out/gated states.
//
// THE FIX (TM-624): #/receipts was folded into router.js exactly like the tier screen (the TM-606
// pattern) — router owns show/hide + auth guard + mount lifecycle + nav reveal; the module's own
// hashchange listener and nav reveal were deleted. Neither router.js nor the receipts DOM shell can be
// imported under `node --test` (both sit on the api.js → Firebase CDN chain), so — like
// events-map-link-a11y.test.mjs — these are source-level guards pinning each half of the fix so the
// self-managed lifecycle can't creep back.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECEIPTS_SRC = readFileSync(join(HERE, "../src/assets/membership-receipts.js"), "utf8");
const ROUTER_SRC = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");

// --- half 1: the module no longer routes itself ------------------------------------------------------

test("membership-receipts.js runs NO hashchange listener / self-init of its own (TM-624)", () => {
  assert.doesNotMatch(
    RECEIPTS_SRC,
    /addEventListener\(\s*["']hashchange["']/,
    "the TM-481 self-managed hashchange listener is what double-rendered against router.js — it must stay deleted",
  );
  // No boot-time self-reveal of the nav link either (it ignored signed-out + gated states).
  assert.doesNotMatch(
    RECEIPTS_SRC,
    /nav-receipts/,
    "the module must not touch the #nav-receipts link — router.js owns the reveal (auth + flag + gate aware)",
  );
  assert.match(
    RECEIPTS_SRC,
    /export\s+async\s+function\s+enterMembershipReceipts/,
    "the router entry point must stay exported",
  );
});

// --- half 2: router.js owns the route end-to-end -----------------------------------------------------

test("router.js knows #/receipts: flag-gated predicate + route resolution (TM-624)", () => {
  assert.match(
    ROUTER_SRC,
    /import\s*\{\s*enterMembershipReceipts\s*\}\s*from\s*"\.\/membership-receipts\.js"/,
    "router.js imports the receipts entry point",
  );
  assert.match(
    ROUTER_SRC,
    /function\s+isReceiptsRoute\(hash\)\s*\{\s*\n?\s*return\s+membershipEnabled\(\)\s*&&\s*hash\s*===\s*RECEIPTS/,
    "isReceiptsRoute must be flag-gated (flag OFF ⇒ unknown hash ⇒ inert), mirroring isMembershipRoute",
  );
  assert.match(
    ROUTER_SRC,
    /if\s*\(isReceiptsRoute\(hash\)\)\s*return\s+hash;/,
    "currentRoute() must resolve #/receipts (this is what stopped the HOME fall-through double-render)",
  );
});

test("router.js auth-guards #/receipts — a signed-out deep link bounces to login, no tokenless fetch (TM-624)", () => {
  const guard = ROUTER_SRC.match(/function\s+isProtected\(route\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(guard, "could not locate isProtected() in router.js");
  assert.match(
    guard[1],
    /isReceiptsRoute\(route\)/,
    "isProtected() must include the receipts route — its absence is what fired GET /me/orders with no token",
  );
});

test("router.js owns the receipts screen's show/hide + mount lifecycle + nav reveal (TM-624)", () => {
  // render() toggles the section (single screen — never stacked on home).
  assert.match(
    ROUTER_SRC,
    /\$\("membership-receipts-screen"\)/,
    "render() must resolve the receipts section to own its visibility",
  );
  assert.match(
    ROUTER_SRC,
    /receiptsView\.hidden\s*=\s*route\s*!==\s*RECEIPTS/,
    "…and hide it on every non-receipts route",
  );
  // guard() mounts on entry (mount-once lifecycle, like the tier screen).
  assert.match(
    ROUTER_SRC,
    /if\s*\(!receiptsActive\)\s*\{\s*\n?\s*receiptsActive\s*=\s*true;\s*\n?\s*enterMembershipReceipts\(\);/,
    "guard() must mount the receipts screen once on entry into #/receipts",
  );
  // The nav link is gated on signed-in AND the flag AND not gated — the states the self-reveal ignored.
  assert.match(
    ROUTER_SRC,
    /navReceipts\.hidden\s*=\s*!\(signedIn\s*&&\s*membershipEnabled\(\)\)\s*\|\|\s*gated/,
    "router.js must gate the #nav-receipts link on signed-in + flag + not-gated",
  );
});
