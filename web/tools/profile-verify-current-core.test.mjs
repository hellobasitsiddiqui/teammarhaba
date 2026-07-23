// TM-1005 — verifying the CURRENT, UNCHANGED stored phone must have a path. Framework-free — Node's
// built-in test runner, the same harness as profile-phone-reverify-core.test.mjs, picked up by the CI
// glob `node --test web/tools/*.test.mjs`.
//
// THE BUG THIS PINS SHUT: an account whose STORED phone was never Firebase-verified (every email-code /
// admin account + every pre-TM-930 legacy account — exactly needsVerifiedPhone's eligibility) was told
// to "verify your number" by the TM-992 grace banner, but NO surface offered a way to verify an
// UNCHANGED number: the TM-982 profile affordance only fires on a phone CHANGE (phoneEditNeedsVerify is
// deliberately a no-op for stored===composed), and the banner's CTA hash-navved to #/onboarding — which
// router.js bounces an already-onboarded user straight off during the grace window. A dead-end.
//
// TWO pure contracts close it, both locked here:
//   1. profile-core.phoneCurrentNeedsVerify(stored, composed, verifiedPhone) — reveal a "Verify this
//      number" affordance on the profile phone field exactly when the form holds the UNCHANGED stored
//      number and that number is not the account's Firebase-verified phone. Never blocks a save.
//   2. phone-reverify-core's CTA contract (REVERIFY_CTA_TARGET + PHONE_VERIFY_REQUEST_EVENT) — the
//      banner's "Verify now" lands on #/profile (NOT the bouncing #/onboarding) and announces itself
//      over a shared event name both halves import from the one pure module.
//
// FAIL-BEFORE / PASS-AFTER: on clean `main` (pre-TM-1005) none of `phoneCurrentNeedsVerify`,
// `REVERIFY_CTA_TARGET` or `PHONE_VERIFY_REQUEST_EVENT` exists — the imports below throw at load, so
// the whole file fails. With the TM-1005 exports present, every assertion passes. Remove the rule and
// this file goes red again: that is the regression proof.

import assert from "node:assert/strict";
import { test } from "node:test";

import { phoneCurrentNeedsVerify, needsVerifiedPhone } from "../src/assets/profile-core.js";
import { REVERIFY_CTA_TARGET, PHONE_VERIFY_REQUEST_EVENT } from "../src/assets/phone-reverify-core.js";

// ---- 1. The headline case: an unchanged, account-unverified stored phone OFFERS verification ------

test("an UNCHANGED stored phone with NO account-verified number offers 'verify current' (the dead-end fix)", () => {
  // The exact TM-1005 account shape: a stored phone (self-reported / seeded), nothing Firebase-linked.
  assert.equal(phoneCurrentNeedsVerify("+447700900123", "+447700900123", null), true);
  assert.equal(phoneCurrentNeedsVerify("+447700900123", "+447700900123", undefined), true);
  assert.equal(phoneCurrentNeedsVerify("+447700900123", "+447700900123", ""), true);
});

test("a stored phone whose account-verified number is a DIFFERENT number still offers 'verify current'", () => {
  // Mismatch case (needsVerifiedPhone's second branch): the linked number isn't the stored one.
  assert.equal(phoneCurrentNeedsVerify("+447700900123", "+447700900123", "+447700900999"), true);
});

// ---- 2. Verified / not-applicable states must NOT offer it (hide once verified) -------------------

test("an account-VERIFIED stored phone does not offer 'verify current' — the affordance hides", () => {
  assert.equal(phoneCurrentNeedsVerify("+447700900123", "+447700900123", "+447700900123"), false);
  // Canonicalisation: formatting-only differences (stored/composed/verified) never re-offer.
  assert.equal(phoneCurrentNeedsVerify("+44 7700 900123", "+447700900123", "+447700900123"), false);
  assert.equal(phoneCurrentNeedsVerify("+447700900123", "+44 7700 900123", "+44 7700 900123"), false);
});

test("no parseable stored phone → false (needsPhoneNumber / confirm-country territory, not this rule)", () => {
  assert.equal(phoneCurrentNeedsVerify("", "+447700900123", null), false);
  assert.equal(phoneCurrentNeedsVerify(null, "", null), false);
  assert.equal(phoneCurrentNeedsVerify(undefined, "", null), false);
  // A legacy bare number (no +CC) is not a parseable stored E.164 — the confirm-country flow owns it.
  assert.equal(phoneCurrentNeedsVerify("07700 900123", "07700 900123", null), false);
});

// ---- 3. Disjointness with the TM-982 changed-number path ------------------------------------------

test("a CHANGED composed number never claims 'verify current' — the TM-982 Send-code path owns it", () => {
  // The two affordance states must be disjoint: once the user edits to a different number, this rule
  // stands down (phoneEditNeedsVerify + "Send code" take over); editing BACK to the stored number
  // re-offers the current-verify.
  assert.equal(phoneCurrentNeedsVerify("+447700900123", "+447700900999", null), false);
  assert.equal(phoneCurrentNeedsVerify("+447700900123", "+14155552671", ""), false);
  // A blank/incomplete form (mid-edit) also stands down — nothing composed to verify yet.
  assert.equal(phoneCurrentNeedsVerify("+447700900123", "", null), false);
});

// ---- 4. Consistency with the shared eligibility rule (needsVerifiedPhone) -------------------------

test("for an unchanged form, phoneCurrentNeedsVerify agrees with needsVerifiedPhone (one eligibility)", () => {
  // The affordance must appear for EXACTLY the accounts the router/banner consider re-verify-eligible —
  // if these two ever disagree, a user could be nagged with no affordance (the dead-end again) or
  // offered verification they don't need. Sweep the interesting shapes with stored===composed.
  const shapes = [
    { phone: "+447700900123", verified: null },
    { phone: "+447700900123", verified: "+447700900123" },
    { phone: "+447700900123", verified: "+447700900999" },
    { phone: "+44 7700 900123", verified: "+447700900123" },
    { phone: "07700 900123", verified: null }, // legacy bare — neither should fire
    { phone: "", verified: null },
  ];
  for (const { phone, verified } of shapes) {
    assert.equal(
      phoneCurrentNeedsVerify(phone, phone, verified),
      needsVerifiedPhone({ phone }, verified),
      `agreement for stored=${JSON.stringify(phone)} verified=${JSON.stringify(verified)}`,
    );
  }
});

// ---- 5. The banner-CTA contract: land on the profile, announce over the shared event --------------

test("the grace-banner CTA contract targets #/profile (NOT the bouncing #/onboarding) + a real event name", () => {
  assert.equal(REVERIFY_CTA_TARGET, "#/profile", "the CTA must land where the verify affordance lives");
  assert.notEqual(REVERIFY_CTA_TARGET, "#/onboarding", "#/onboarding bounces onboarded users — the dead-end");
  assert.equal(typeof PHONE_VERIFY_REQUEST_EVENT, "string");
  assert.ok(PHONE_VERIFY_REQUEST_EVENT.length > 0, "the handoff event name must be a non-empty string");
});
