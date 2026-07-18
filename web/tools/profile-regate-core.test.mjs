// Re-gate coverage for the TM-880 phone-completion wiring (TM-899 — TM-892 review finding, PR #587 M2).
// Framework-free — Node's built-in test runner, the same harness as profile-core.test.mjs, picked up
// by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE GAP THIS CLOSES: TM-880's headline behaviour is re-gating EXISTING accounts — any signed-in
// user whose stored phone is missing or not a parseable E.164 value is routed back through the
// `#/onboarding` completion gate, onboardingCompleted=true or not. But every pre-existing gate spec
// used a brand-new user (gated by onboardingCompleted=false regardless), so the router's
// `&& !needsPhoneNumber(...)` term and needsPhoneNumber's legacy-bare / unknown-dial / fail-open
// branches were exercised by NOTHING — a refactor could drop any of them with every suite green.
//
// Two layers here (both on the fast PR gate — the behavioural e2e sibling, profile-regate.spec.mjs,
// runs on main only, so THIS file is what protects a PR):
//   1. behavioural tests of the REAL shipped needsPhoneNumber (profile-core.js imports cleanly under
//      `node --test` — no DOM, no Firebase), pinning every branch the review found uncovered;
//   2. a source-level guard on router.js's isOnboarded ternary (router.js can't be imported in Node —
//      the api.js → Firebase CDN chain — so, like router-gate-chain-guard.test.mjs, it pins the
//      wiring as text): the needsPhoneNumber term AND the degraded-/me fail-open must both survive.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { needsPhoneNumber } from "../src/assets/profile-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER_SRC = readFileSync(join(HERE, "../src/assets/router.js"), "utf8");

// A minimal /me-shaped object — needsPhoneNumber reads only `me.phone` (its documented contract).
const me = (phone) => ({ uid: "abc", email: "regate@example.com", onboardingCompleted: true, phone });

// ---- 1. A valid stored E.164 phone → NOT re-gated --------------------------------------------------

test("a valid stored E.164 phone does not trigger the completion gate", () => {
  assert.equal(needsPhoneNumber(me("+447700900123")), false);
  // Separator formatting is allowed in the stored shape (spaces & friends between digits) — the
  // splitE164 parse strips them, so a formatted-but-valid value must not re-gate either.
  assert.equal(needsPhoneNumber(me("+44 7700 900123")), false);
  // A non-GB dial code parses the same way — the rule is "parseable E.164", not "British".
  assert.equal(needsPhoneNumber(me("+14155552671")), false);
});

// ---- 2. No phone on record → re-gated (the TM-880 mandatory-phone rule) ----------------------------

test("a null / missing / blank stored phone re-gates the account", () => {
  assert.equal(needsPhoneNumber(me(null)), true);
  assert.equal(needsPhoneNumber(me(undefined)), true);
  assert.equal(needsPhoneNumber(me("")), true);
  const noPhoneKey = me("+447700900123");
  delete noPhoneKey.phone;
  assert.equal(needsPhoneNumber(noPhoneKey), true);
});

// ---- 3. A legacy bare national number (pre-TM-781, no +CC) → re-gated ------------------------------

test("a legacy bare number (no +country-code, saved pre-TM-781) re-gates the account", () => {
  // Country-ambiguous: stored before TM-781 required the composed +CC shape. The user must confirm
  // its country through the gate — the same confirm-country rule the edit form enforces.
  assert.equal(needsPhoneNumber(me("07700900123")), true);
  assert.equal(needsPhoneNumber(me("7700 900123")), true);
});

// ---- 4. An unknown dial code → re-gated (pinning the SHIPPED behaviour) ----------------------------

test("a '+' value with an unassigned dial code re-gates the account (shipped splitE164-null behaviour)", () => {
  // splitE164 walks DIALS_LONGEST_FIRST and returns null when no known dial code prefixes the digits
  // — so a "+"-shaped value with an unassigned prefix counts as "no valid stored phone" and the gate
  // intercepts (the user re-confirms their country + number). Pinned so a later "looks E.164-ish,
  // let it through" relaxation is a deliberate, test-visible choice.
  assert.equal(needsPhoneNumber(me("+9991234567")), true); // 999 is not an assigned dial code
  assert.equal(needsPhoneNumber(me("+01234567")), true); // no dial code starts with 0
});

// ---- 5. Degraded /me → fail OPEN (the router.js contract) ------------------------------------------

test("a null/undefined (degraded) /me fails OPEN — never gates on a backend hiccup", () => {
  // The router's documented contract (router.js resolveRoleThenGuard): a degraded GET /me must never
  // trap a user behind a gate — the backend stays the real authority (it refuses onboarding-complete
  // without a valid phone). needsPhoneNumber mirrors the onboarding + terms gates' fail-open shape.
  assert.equal(needsPhoneNumber(null), false);
  assert.equal(needsPhoneNumber(undefined), false);
});

// ---- 6. Source guard: the router actually CONSULTS needsPhoneNumber (the TM-880 wiring) ------------

test("router.js gates isOnboarded on needsPhoneNumber AND keeps the degraded-/me fail-open", () => {
  // The whole ternary, pinned as one unit: a resolved /me is "onboarded" only when the flag is set
  // AND no phone completion is needed; a degraded /me (null) resolves to true (fail open — not
  // gated). Dropping the `!needsPhoneNumber(...)` term (the exact refactor risk TM-892 flagged)
  // or flipping the `: true` fallback fails here, on the fast PR gate — the behavioural e2e
  // (profile-regate.spec.mjs) only runs on main.
  assert.match(
    ROUTER_SRC,
    /isOnboarded\s*=\s*onboardedOutcome\.value\s*\?\s*Boolean\(onboardedOutcome\.value\.onboardingCompleted\)\s*&&\s*!needsPhoneNumber\(onboardedOutcome\.value\)\s*:\s*true\s*;/,
    "router.js must compute isOnboarded as `value ? Boolean(value.onboardingCompleted) && " +
      "!needsPhoneNumber(value) : true` — the TM-880 re-gate term and the degraded-/me fail-open " +
      "are both load-bearing",
  );
  // And the term must be the REAL shared rule, not a local reimplementation that could drift from
  // what the profile/onboarding forms enforce.
  assert.match(
    ROUTER_SRC,
    /import\s*\{\s*needsPhoneNumber\s*\}\s*from\s*"\.\/profile-core\.js"\s*;/,
    "router.js must import needsPhoneNumber from profile-core.js (the single shared gate rule)",
  );
});
