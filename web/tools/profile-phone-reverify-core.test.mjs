// TM-982 — profile phone-edit must re-verify (verified-identity phone). Framework-free — Node's
// built-in test runner, the same harness as profile-core.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// WHAT THIS PROTECTS: phone is a VERIFIED IDENTITY (unique, must re-verify to change). The pure rule
// `phoneEditNeedsVerify(stored, composed, verifiedComposed)` decides whether a profile save must be
// BLOCKED until the number now in the form has been Firebase OTP-verified + linked. The DOM half
// (profile.js) delegates the save-block AND the "Send code" affordance to this rule, so pinning every
// branch here is what guards the behaviour on the fast PR gate (profile.js can't be imported under
// `node --test` — the Firebase CDN chain — so its verify wiring is proven behaviourally in
// profile-edit-behaviour.test.mjs; THIS file locks the decision the wiring consults).
//
// FAIL-BEFORE / PASS-AFTER: on clean `main` (pre-TM-982) neither `phoneEditNeedsVerify` nor the shared
// `canonicalE164` export exists — this file's `import { phoneEditNeedsVerify, canonicalE164 }` throws at
// load, so the whole suite fails. With the TM-982 export present, every assertion below passes. That is
// the regression proof: remove the rule and this file goes red.

import assert from "node:assert/strict";
import { test } from "node:test";

import { phoneEditNeedsVerify, canonicalE164 } from "../src/assets/profile-core.js";

// ---- canonicalE164: the shared canonicalisation the gate + the router now both use ----------------

test("canonicalE164 strips formatting to Firebase's strict E.164, and returns '' for non-E.164", () => {
  assert.equal(canonicalE164("+44 7700 900123"), "+447700900123", "separators are stripped");
  assert.equal(canonicalE164("+447700900123"), "+447700900123", "an already-strict value round-trips");
  assert.equal(canonicalE164("+1 415 555 2671"), "+14155552671", "a non-GB pair canonicalises too");
  // Non-E.164 values → "" (blank, a legacy bare number with no +dial, an unassigned dial code, junk).
  assert.equal(canonicalE164(""), "", "blank");
  assert.equal(canonicalE164(null), "", "null");
  assert.equal(canonicalE164(undefined), "", "undefined");
  assert.equal(canonicalE164("07700900123"), "", "a legacy bare number (no +CC) is not E.164");
  assert.equal(canonicalE164("+9991234567"), "", "an unassigned dial code");
  assert.equal(canonicalE164("not-a-phone"), "", "junk");
});

// ---- 1. An UNCHANGED phone never needs re-verify (the no-op case) ---------------------------------

test("an UNCHANGED phone needs no re-verify — editing only the city/name must still save", () => {
  // The crux of TM-982: a user editing their city (leaving the phone alone) must NOT be forced to OTP a
  // number they didn't touch. Same number in → false, whatever the verified value is.
  assert.equal(phoneEditNeedsVerify("+447700900123", "+447700900123", ""), false);
  assert.equal(phoneEditNeedsVerify("+447700900123", "+447700900123", "+447700900123"), false);
  // Canonicalisation: a formatting-only difference between the stored and the composed value is NOT a
  // change — without canonicalising, a formatted stored value would false-demand a re-verify.
  assert.equal(phoneEditNeedsVerify("+44 7700 900123", "+447700900123", ""), false);
  assert.equal(phoneEditNeedsVerify("+447700900123", "+44 7700 900123", ""), false);
});

// ---- 2. A CHANGED, UNVERIFIED phone MUST be blocked (the headline rule) ---------------------------

test("a CHANGED phone that has NOT been verified this session blocks the save", () => {
  // A different number in the form, nothing verified → block (must OTP the new number first).
  assert.equal(phoneEditNeedsVerify("+447700900123", "+447700900999", ""), true);
  // Verified a DIFFERENT number than the one now composed → still block (the composed one isn't proven).
  assert.equal(phoneEditNeedsVerify("+447700900123", "+447700900999", "+447700900888"), true);
  // Changing to another country entirely, unverified → block.
  assert.equal(phoneEditNeedsVerify("+447700900123", "+14155552671", ""), true);
});

// ---- 3. A CHANGED, VERIFIED phone saves (the happy path after OTP) --------------------------------

test("a CHANGED phone that WAS verified this session (exact match) is allowed to save", () => {
  // The composed number equals the number the user just proved they own → allow.
  assert.equal(phoneEditNeedsVerify("+447700900123", "+447700900999", "+447700900999"), false);
  // Canonicalisation holds on the verified side too: a formatted verified value still matches a strict
  // composed one (and vice-versa) — only a genuine number difference blocks, never a separator one.
  assert.equal(phoneEditNeedsVerify("+447700900123", "+447700900999", "+44 7700 900999"), false);
  assert.equal(phoneEditNeedsVerify("+447700900123", "+44 7700 900999", "+447700900999"), false);
});

// ---- 4. A BLANK / omitted composed phone never gates (leave-unchanged PATCH semantics) ------------

test("a blank / unparseable composed phone is a no-op — nothing to verify, save proceeds", () => {
  // collectPatch omits a blank phone ("leave unchanged"), so there is nothing to verify — never block on
  // it (the required-shape / confirm-country validation owns the blank + legacy-bare cases separately).
  assert.equal(phoneEditNeedsVerify("+447700900123", "", ""), false);
  assert.equal(phoneEditNeedsVerify("+447700900123", null, ""), false);
  assert.equal(phoneEditNeedsVerify("+447700900123", undefined, ""), false);
  // A composed value that isn't parseable E.164 (a legacy bare number still in the confirm-country
  // state) canonicalises to "" → treated as "nothing to verify" here; the confirm-country validation
  // blocks that save with its own targeted message BEFORE this gate is consulted.
  assert.equal(phoneEditNeedsVerify("+447700900123", "07700900123", ""), false);
});

// ---- 5. First-time SET of a phone (no stored value) treats the new number as a change ------------

test("setting a phone where none was stored treats it as a change requiring verification", () => {
  // No stored E.164 (a brand-new / phone-less account editing in the phone here): a real composed number
  // is a change → must be verified. This is the "resolve a legacy/absent number to a concrete E.164"
  // path — establishing the verified-identity number, so an OTP is required.
  assert.equal(phoneEditNeedsVerify("", "+447700900123", ""), true);
  assert.equal(phoneEditNeedsVerify(null, "+447700900123", ""), true);
  // …and it saves once that exact number is verified.
  assert.equal(phoneEditNeedsVerify("", "+447700900123", "+447700900123"), false);
});
