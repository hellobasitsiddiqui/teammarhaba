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

import { needsPhoneNumber, needsVerifiedPhone } from "../src/assets/profile-core.js";

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

// ==== TM-932: needsVerifiedPhone — the retroactive verified-phone re-gate ==========================
//
// Behavioural coverage of every branch of the new pure rule. The router now gates on
// `!needsVerifiedPhone(me, currentUser().phoneNumber)` too, so an account whose STORED phone isn't the
// one Firebase has VERIFIED is re-routed through the OTP verify gate — extending the TM-880 mandatory-
// phone gate to strict "one verified number = one account" (TM-923). These lock every branch so a
// refactor can't silently drop the mismatch/no-verified cases, or weaken the fail-open contract.

// ---- 7. Stored phone matches the verified phone → NOT re-gated ------------------------------------

test("a stored phone that equals the account's verified Firebase phone does NOT re-gate", () => {
  // The already-verified account (verified one number, stored the same) is not gated.
  assert.equal(needsVerifiedPhone(me("+447700900123"), "+447700900123"), false);
  // Canonicalisation: Firebase returns strict E.164 ("+447700900123") but the STORED value may carry
  // separators ("+44 7700 900123") — a formatting-only difference must NOT gate (both canonicalise
  // to the same E.164). This is the crux: without canonicalising, a formatted stored value would
  // false-gate an account whose number is genuinely verified.
  assert.equal(needsVerifiedPhone(me("+44 7700 900123"), "+447700900123"), false);
  assert.equal(needsVerifiedPhone(me("+447700900123"), "+44 7700 900123"), false);
  // A non-GB pair round-trips the same way.
  assert.equal(needsVerifiedPhone(me("+1 415 555 2671"), "+14155552671"), false);
});

// ---- 8. Stored phone but NO verified phone linked → re-gated (the common retroactive case) --------

test("a stored phone with NO linked/verified Firebase phone re-gates the account (retroactive)", () => {
  // The headline TM-932 case: an EXISTING account with a self-reported phone that was never OTP-verified
  // (no phone credential linked → currentUser().phoneNumber is null) is forced through the verify gate.
  assert.equal(needsVerifiedPhone(me("+447700900123"), null), true);
  assert.equal(needsVerifiedPhone(me("+447700900123"), undefined), true);
  assert.equal(needsVerifiedPhone(me("+447700900123"), ""), true);
});

// ---- 9. Stored phone DIFFERS from the verified phone → re-gated (the mismatch case) ---------------

test("a stored phone that differs from the linked verified phone re-gates the account (mismatch)", () => {
  // Verified one number, stored a different one — the stored value isn't the proven one, so gate.
  assert.equal(needsVerifiedPhone(me("+447700900123"), "+447700900999"), true);
  // Different country entirely.
  assert.equal(needsVerifiedPhone(me("+14155552671"), "+447700900123"), true);
  // An UNPARSEABLE verified value can't match any real stored number → gate (re-verify). Defensive:
  // Firebase should always return clean E.164, but a garbage value must fail closed to "re-verify",
  // never accidentally pass as "matches".
  assert.equal(needsVerifiedPhone(me("+447700900123"), "not-a-phone"), true);
});

// ---- 10. No parseable stored phone → NOT this rule's job (orthogonal to needsPhoneNumber) ---------

test("no parseable stored phone → needsVerifiedPhone is false (that's needsPhoneNumber's term)", () => {
  // The two terms are kept orthogonal so they never double-count. A missing/blank/legacy-bare/unknown-
  // dial stored phone is needsPhoneNumber's gate; needsVerifiedPhone stays out of it (returns false)
  // even when NO verified phone is linked — otherwise a phone-less account would trip BOTH terms.
  assert.equal(needsVerifiedPhone(me(null), null), false);
  assert.equal(needsVerifiedPhone(me(""), null), false);
  assert.equal(needsVerifiedPhone(me("07700900123"), null), false); // legacy bare (no +CC)
  assert.equal(needsVerifiedPhone(me("+9991234567"), null), false); // unassigned dial code
  // Even with a verified phone on the account, an unparseable STORED value is not this rule's concern.
  assert.equal(needsVerifiedPhone(me("07700900123"), "+447700900123"), false);
});

// ---- 11. Degraded /me → fail OPEN (the same router contract as needsPhoneNumber) ------------------

test("needsVerifiedPhone fails OPEN on a null/undefined (degraded) /me — never gates on a hiccup", () => {
  // The load-bearing safety contract, identical to needsPhoneNumber: a degraded GET /me must NEVER
  // trap a user behind a gate, whatever the verified phone is. This is the exact pin the router relies
  // on (the `: true` fail-open branch handles a null OUTCOME; this handles a null me object itself).
  assert.equal(needsVerifiedPhone(null, "+447700900123"), false);
  assert.equal(needsVerifiedPhone(undefined, "+447700900123"), false);
  assert.equal(needsVerifiedPhone(null, null), false);
});

// ---- 12. Source guard: the router actually CONSULTS needsPhoneNumber (the TM-880 wiring) ----------

test("router.js gates isOnboarded on needsPhoneNumber AND needsVerifiedPhone AND keeps the degraded-/me fail-open", () => {
  // The whole ternary, pinned as one unit: a resolved /me is "onboarded" only when the flag is set
  // AND no phone completion is needed (TM-880) AND the stored phone is Firebase-VERIFIED (TM-932 — the
  // verified number comes from the uid-pinned `now.phoneNumber`, NOT /me); a degraded /me (null)
  // resolves to true (fail open — not gated). Dropping EITHER phone term (the exact refactor risk
  // TM-892 flagged for needsPhoneNumber, extended to needsVerifiedPhone) or flipping the `: true`
  // fallback fails here, on the fast PR gate — the behavioural e2e (profile-regate.spec.mjs) only runs
  // on main. NB: this pin is DELIBERATELY updated whenever the ternary's shape changes (TM-932 added
  // the second term); it is a guard, not a straitjacket — extend it, don't delete it.
  assert.match(
    ROUTER_SRC,
    /isOnboarded\s*=\s*onboardedOutcome\.value\s*\?\s*Boolean\(onboardedOutcome\.value\.onboardingCompleted\)\s*&&\s*!needsPhoneNumber\(onboardedOutcome\.value\)\s*&&\s*!needsVerifiedPhone\(onboardedOutcome\.value,\s*now\.phoneNumber\)\s*:\s*true\s*;/,
    "router.js must compute isOnboarded as `value ? Boolean(value.onboardingCompleted) && " +
      "!needsPhoneNumber(value) && !needsVerifiedPhone(value, now.phoneNumber) : true` — the TM-880 " +
      "phone-present term, the TM-932 verified-phone term, and the degraded-/me fail-open are all " +
      "load-bearing",
  );
  // And BOTH terms must be the REAL shared rules, not local reimplementations that could drift from
  // what the profile/onboarding forms enforce.
  assert.match(
    ROUTER_SRC,
    /import\s*\{\s*needsPhoneNumber,\s*needsVerifiedPhone\s*\}\s*from\s*"\.\/profile-core\.js"\s*;/,
    "router.js must import needsPhoneNumber AND needsVerifiedPhone from profile-core.js (the single " +
      "shared gate rules)",
  );
});
