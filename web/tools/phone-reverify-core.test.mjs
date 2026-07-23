// Unit coverage for the retroactive phone re-verify decision (TM-992 — GRACE, then FORCE).
//
// Framework-free — Node's built-in test runner, the same harness as profile-regate-core.test.mjs,
// picked up by the CI glob `node --test web/tools/*.test.mjs`. This is the fast PR gate for the whole
// grace→force POLICY: given (needs-reverify?, deadline, now) the decision must be exactly one of
// `none` | `grace-nudge` | `hard-gate`, and — the load-bearing safety property — an eligible account
// with NO configured deadline must be GRACE-ONLY (never hard-gated), so we can't lock users out before
// product picks a date.
//
// It also SOURCE-GUARDS the router wiring: the router must gate isOnboarded on the HARD-GATE decision
// (not the raw needsVerifiedPhone term the way TM-932 did), because the grace→force softening is
// invisible to any test that only checks the pure rule — router.js can't be imported under `node --test`
// (its api.js → Firebase CDN chain), so, like router-gate-chain-guard.test.mjs, we pin the wiring as text.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  phoneReverifyDecision,
  parseReverifyDeadline,
  reverifyNoticeText,
  ReverifyDecision,
} from "../src/assets/phone-reverify-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER_SRC = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");

// A fixed "now" so the window comparisons are deterministic. 2026-08-01T00:00:00Z.
const NOW = Date.parse("2026-08-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

// ---- 1. A verified (not-eligible) account → NONE, whatever the deadline ---------------------------

test("a verified account (needsReverify=false) is never nudged and never gated — NONE", () => {
  // The headline safety property: a user who already verified their number is left completely alone,
  // regardless of whether a deadline is set or has passed.
  assert.equal(phoneReverifyDecision({ needsReverify: false, deadline: null, now: NOW }), ReverifyDecision.NONE);
  assert.equal(
    phoneReverifyDecision({ needsReverify: false, deadline: NOW - DAY, now: NOW }),
    ReverifyDecision.NONE,
  );
  assert.equal(
    phoneReverifyDecision({ needsReverify: false, deadline: NOW + DAY, now: NOW }),
    ReverifyDecision.NONE,
  );
});

// ---- 2. Eligible + NO deadline configured → GRACE-ONLY (the SAFE DEFAULT) --------------------------

test("an eligible account with NO configured deadline is GRACE-ONLY — never hard-gated", () => {
  // THE crux of TM-992's safe default: until product sets an actual deadline we must NOT lock existing
  // users out. Eligible-but-no-deadline resolves to the nudge, never the gate — for null AND undefined.
  assert.equal(
    phoneReverifyDecision({ needsReverify: true, deadline: null, now: NOW }),
    ReverifyDecision.GRACE_NUDGE,
  );
  assert.equal(
    phoneReverifyDecision({ needsReverify: true, deadline: undefined, now: NOW }),
    ReverifyDecision.GRACE_NUDGE,
  );
  // A non-finite deadline (NaN — e.g. an unparseable config value) also degrades to grace-only, never
  // an accidental hard-gate on a date we couldn't read.
  assert.equal(
    phoneReverifyDecision({ needsReverify: true, deadline: NaN, now: NOW }),
    ReverifyDecision.GRACE_NUDGE,
  );
});

// ---- 3. Eligible + deadline in the FUTURE → GRACE_NUDGE (inside the grace window) ------------------

test("an eligible account before the deadline gets the soft nudge — GRACE_NUDGE", () => {
  assert.equal(
    phoneReverifyDecision({ needsReverify: true, deadline: NOW + DAY, now: NOW }),
    ReverifyDecision.GRACE_NUDGE,
  );
  // One millisecond before the deadline is still inside the window.
  assert.equal(
    phoneReverifyDecision({ needsReverify: true, deadline: NOW + 1, now: NOW }),
    ReverifyDecision.GRACE_NUDGE,
  );
});

// ---- 4. Eligible + deadline PASSED → HARD_GATE (grace is over → force verify) ----------------------

test("an eligible account at/after the deadline is hard-gated — HARD_GATE", () => {
  // Strictly after.
  assert.equal(
    phoneReverifyDecision({ needsReverify: true, deadline: NOW - DAY, now: NOW }),
    ReverifyDecision.HARD_GATE,
  );
  // Boundary: exactly AT the deadline gates (the deadline is the moment grace ends — `now >= deadline`).
  assert.equal(
    phoneReverifyDecision({ needsReverify: true, deadline: NOW, now: NOW }),
    ReverifyDecision.HARD_GATE,
  );
});

// ---- 5. parseReverifyDeadline — accepts ISO + epoch-ms, rejects garbage to null -------------------

test("parseReverifyDeadline accepts ISO strings and epoch-ms, and maps absent/garbage to null", () => {
  // Absent → null (the grace-only trigger).
  assert.equal(parseReverifyDeadline(null), null);
  assert.equal(parseReverifyDeadline(undefined), null);
  assert.equal(parseReverifyDeadline(""), null);
  // ISO date + full timestamp → the right epoch-ms.
  assert.equal(parseReverifyDeadline("2026-09-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(parseReverifyDeadline("2026-09-01"), Date.parse("2026-09-01"));
  // Numeric epoch-ms (number and numeric-string) → itself.
  assert.equal(parseReverifyDeadline(NOW), NOW);
  assert.equal(parseReverifyDeadline(String(NOW)), NOW);
  // Garbage strings → null (so a typo degrades to grace-only, never an accidental gate).
  assert.equal(parseReverifyDeadline("not-a-date"), null);
  assert.equal(parseReverifyDeadline("soon"), null);
  // Non-finite number → null.
  assert.equal(parseReverifyDeadline(NaN), null);
});

// ---- 6. parse → decide round-trips end-to-end -----------------------------------------------------

test("a configured ISO deadline flows through parse → decide as expected across the boundary", () => {
  const deadline = parseReverifyDeadline("2026-08-01T00:00:00Z"); // == NOW
  // Just before → nudge; just after → gate.
  assert.equal(
    phoneReverifyDecision({ needsReverify: true, deadline, now: NOW - 1 }),
    ReverifyDecision.GRACE_NUDGE,
  );
  assert.equal(
    phoneReverifyDecision({ needsReverify: true, deadline, now: NOW + 1 }),
    ReverifyDecision.HARD_GATE,
  );
});

// ---- 7. reverifyNoticeText — names the deadline when set, omits it when grace-only ----------------

test("reverifyNoticeText quotes the deadline when set, and omits any date when none is configured", () => {
  // A deterministic formatter so the assertion doesn't depend on the host locale/timezone.
  const fmt = () => "1 Sep 2026";
  const withDeadline = reverifyNoticeText(NOW, fmt);
  assert.match(withDeadline, /verify your phone number/i);
  assert.match(withDeadline, /by 1 Sep 2026/); // the date is named
  // No deadline (the grace-only safe default) → still asks to verify, but names no date to quote.
  const noDeadline = reverifyNoticeText(null, fmt);
  assert.match(noDeadline, /verify your phone number/i);
  assert.doesNotMatch(noDeadline, /\bby\b/i); // no "by <date>" — there is no cut-off yet
  // Unparseable (NaN) also degrades to the no-date copy.
  assert.doesNotMatch(reverifyNoticeText(NaN, fmt), /\bby\b/i);
});

// ---- 8. Source guard: the router gates isOnboarded on the HARD-GATE decision (grace≠gate) ----------

test("router.js folds the verified-phone term into the gate ONLY when the reverify decision is HARD_GATE", () => {
  // The TM-992 wiring, pinned as text (router.js can't be imported under node --test — the api.js →
  // Firebase CDN chain). Two properties the grace→force softening depends on:
  //   (a) the router must consult phoneReverifyDecision (not fold the raw needsVerifiedPhone straight
  //       into isOnboarded the way TM-932 did — that would hard-gate with no grace);
  //   (b) it must compare that decision to the HARD_GATE outcome to decide whether to gate.
  // If a refactor drops the decision call or compares against the wrong outcome, this fails on the fast
  // PR gate. NB: this is a guard, not a straitjacket — update it deliberately if the wiring's shape
  // legitimately changes; don't delete it.
  assert.match(
    ROUTER_SRC,
    /import\s*\{[^}]*\bphoneReverifyDecision\b[^}]*\}\s*from\s*"\.\/phone-reverify-core\.js"\s*;/,
    "router.js must import phoneReverifyDecision from phone-reverify-core.js (the shared grace→force rule)",
  );
  assert.match(
    ROUTER_SRC,
    /phoneReverifyDecision\s*\(/,
    "router.js must CALL phoneReverifyDecision to decide grace-vs-force (not fold needsVerifiedPhone " +
      "straight into isOnboarded like TM-932)",
  );
  assert.match(
    ROUTER_SRC,
    /ReverifyDecision\.HARD_GATE/,
    "router.js must gate only on the HARD_GATE decision — a GRACE_NUDGE must NOT re-gate the user",
  );
});
