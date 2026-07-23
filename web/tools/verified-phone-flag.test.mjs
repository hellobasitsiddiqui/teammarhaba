// TM-1009 — deploy-time feature switch for the WHOLE verified-phone requirement.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// WHAT THIS LOCKS. `config.flags.requireVerifiedPhone` (web/src/assets/config.js) is the single client
// switch over every "your phone must be Firebase-OTP-verified" behaviour:
//   • the router's retroactive re-gate term (needsVerifiedPhone → phoneReverifyDecision → the HARD_GATE
//     term folded into isOnboarded, TM-932/TM-992) — flag OFF ⇒ existing unverified accounts are NOT
//     re-gated (and the grace nudge banner stays away too);
//   • the onboarding gate's "must verify to continue" submit block (TM-930) — flag OFF ⇒ the gate just
//     COLLECTS the number (TM-880 mandatory-present stays) and lets the user continue;
//   • the profile phone-edit re-verify save block (TM-982) — flag OFF ⇒ a changed number saves without
//     an OTP.
// Flag ON = exactly the pre-TM-1009 behaviour, unchanged. The committed default is OFF so testing and
// onboarding are never blocked; go-live flips it at DEPLOY time (the same sed seam as the membership
// flag, TM-725) — never by a source edit.
//
// Real end-to-end enforcement needs BOTH this client flag AND the server flag
// (`app.phone.require-verified`, PhoneVerificationProperties — also default false, TM-931/TM-986).
// This suite covers the client half: the pure gate logic, the committed OFF default, the deploy
// injection seam, and the call-site wiring (source-level pins, since router.js/onboarding.js/profile.js
// sit on the Firebase CDN import chain and can't be imported under `node --test`).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  requireVerifiedPhoneFlag,
  verifiedPhoneRequired,
  effectiveReverifyDecision,
  phoneVerifyBlocksSubmit,
} from "../src/assets/verified-phone-flag.js";
import { ReverifyDecision } from "../src/assets/phone-reverify-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), "utf8");
/** Strip `//` line comments so doc-comment mentions of a token can't false-positive a source pin. */
const stripComments = (src) =>
  src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

// --- the pure flag reader ---------------------------------------------------------------------------

test("requireVerifiedPhoneFlag: absent config/flags/key all mean OFF (the safe default)", () => {
  assert.equal(requireVerifiedPhoneFlag(undefined), false);
  assert.equal(requireVerifiedPhoneFlag(null), false);
  assert.equal(requireVerifiedPhoneFlag({}), false);
  assert.equal(requireVerifiedPhoneFlag({ flags: {} }), false);
  assert.equal(requireVerifiedPhoneFlag({ flags: { membership: true } }), false);
});

test("requireVerifiedPhoneFlag: explicit values read through (booleans; truthiness coerced)", () => {
  assert.equal(requireVerifiedPhoneFlag({ flags: { requireVerifiedPhone: true } }), true);
  assert.equal(requireVerifiedPhoneFlag({ flags: { requireVerifiedPhone: false } }), false);
  // Same `!!` coercion contract as membershipEnabled(): a truthy injected value counts as ON.
  assert.equal(requireVerifiedPhoneFlag({ flags: { requireVerifiedPhone: "true" } }), true);
});

test("verifiedPhoneRequired(): reads window.TEAMMARHABA_CONFIG, false off-DOM / when unset", () => {
  // Off-DOM (no window at all) must not throw and must fail safe to OFF.
  delete globalThis.window;
  assert.equal(verifiedPhoneRequired(), false);
  try {
    globalThis.window = { TEAMMARHABA_CONFIG: { flags: {} } };
    assert.equal(verifiedPhoneRequired(), false, "flag absent → OFF");
    globalThis.window = { TEAMMARHABA_CONFIG: { flags: { requireVerifiedPhone: true } } };
    assert.equal(verifiedPhoneRequired(), true, "flag set → ON");
  } finally {
    delete globalThis.window;
  }
});

// --- the router re-gate term (flag OFF excludes the verified-phone term from isOnboarded) -----------

test("effectiveReverifyDecision: flag OFF collapses EVERY decision to NONE (no re-gate, no nudge)", () => {
  // HARD_GATE is the decision that folds into router.js isOnboarded — OFF must exclude that term, so
  // an existing unverified account is NOT bounced to #/onboarding even past a configured deadline.
  assert.equal(effectiveReverifyDecision(false, ReverifyDecision.HARD_GATE), ReverifyDecision.NONE);
  // GRACE_NUDGE drives the phone-reverify-notice banner — OFF suppresses the nag too.
  assert.equal(effectiveReverifyDecision(false, ReverifyDecision.GRACE_NUDGE), ReverifyDecision.NONE);
  assert.equal(effectiveReverifyDecision(false, ReverifyDecision.NONE), ReverifyDecision.NONE);
});

test("effectiveReverifyDecision: flag ON passes every decision through unchanged (current behaviour)", () => {
  assert.equal(effectiveReverifyDecision(true, ReverifyDecision.HARD_GATE), ReverifyDecision.HARD_GATE);
  assert.equal(effectiveReverifyDecision(true, ReverifyDecision.GRACE_NUDGE), ReverifyDecision.GRACE_NUDGE);
  assert.equal(effectiveReverifyDecision(true, ReverifyDecision.NONE), ReverifyDecision.NONE);
});

// --- the onboarding gate submit block (flag OFF = collect only, no forced OTP) ----------------------

test("phoneVerifyBlocksSubmit: flag OFF never blocks the gate submit (collect-only, pre-TM-930)", () => {
  assert.equal(phoneVerifyBlocksSubmit(false, false), false, "unverified + flag OFF → continue");
  assert.equal(phoneVerifyBlocksSubmit(false, true), false, "verified + flag OFF → continue");
});

test("phoneVerifyBlocksSubmit: flag ON keeps the TM-930 must-verify block exactly as-is", () => {
  assert.equal(phoneVerifyBlocksSubmit(true, false), true, "unverified + flag ON → blocked");
  assert.equal(phoneVerifyBlocksSubmit(true, true), false, "verified + flag ON → continue");
});

// --- committed default: config.js ships the flag OFF ------------------------------------------------

test("config.js ships requireVerifiedPhone OFF (committed default matches the ticket)", () => {
  const code = stripComments(read("../src/assets/config.js"));
  assert.match(code, /\brequireVerifiedPhone\s*:\s*false\b/, "config.js must ship `requireVerifiedPhone: false`");
  assert.doesNotMatch(code, /\brequireVerifiedPhone\s*:\s*true\b/, "config.js must not ship the flag ON");
});

// --- deploy seam: go-live is a deploy toggle, not a source edit -------------------------------------

test("deploy.yml carries the opt-in verified-phone injection seam (mirrors the membership seam)", () => {
  const deploy = read("../../.github/workflows/deploy.yml");
  assert.ok(
    deploy.includes("Inject web verified-phone flag into config.js"),
    "the verified-phone-flag injection step must exist in deploy.yml",
  );
  assert.ok(
    deploy.includes("WEB_REQUIRE_VERIFIED_PHONE"),
    "the injection must be gated on the explicit WEB_REQUIRE_VERIFIED_PHONE repo variable",
  );
  assert.ok(
    deploy.includes("s#requireVerifiedPhone: false#requireVerifiedPhone: true#"),
    "the seam must sed `requireVerifiedPhone: false` -> `requireVerifiedPhone: true` (the committed token)",
  );
});

// --- call-site wiring (source-level pins — these were RED before TM-1009 wired the flag in) ---------

test("router.js short-circuits the verified-phone re-gate term through the flag", () => {
  const src = read("../src/assets/router.js");
  // The reverify decision the isOnboarded fold consumes must pass through effectiveReverifyDecision
  // keyed on verifiedPhoneRequired() — needsVerifiedPhone itself stays pure, the short-circuit lives
  // at this call site.
  assert.match(
    src,
    /effectiveReverifyDecision\(\s*verifiedPhoneRequired\(\)/,
    "router.js must wrap phoneReverifyDecision in effectiveReverifyDecision(verifiedPhoneRequired(), …)",
  );
});

test("onboarding.js gates BOTH the must-verify submit block and the verify-controls build on the flag", () => {
  const src = stripComments(read("../src/assets/onboarding.js"));
  assert.match(
    src,
    /phoneVerifyBlocksSubmit\(\s*verifiedPhoneRequired\(\)\s*,\s*phoneIsVerified\(\)\s*\)/,
    "validateAll must consult phoneVerifyBlocksSubmit(verifiedPhoneRequired(), phoneIsVerified())",
  );
  assert.match(
    src,
    /field\.field\s*===\s*"phone"\s*&&\s*verifiedPhoneRequired\(\)/,
    "the Send-code/OTP verify controls must only be built when the flag is ON",
  );
});

test("profile.js phone-edit save gate (TM-982) is a no-op when the flag is OFF", () => {
  const src = stripComments(read("../src/assets/profile.js"));
  assert.match(
    src,
    /if\s*\(\s*!verifiedPhoneRequired\(\)\s*\)\s*return\s+false;/,
    "phoneNeedsVerify must early-return false when the flag is OFF",
  );
});

test("phone-reverify-notice.js suppresses the grace nudge when the flag is OFF", () => {
  const src = read("../src/assets/phone-reverify-notice.js");
  assert.match(
    src,
    /effectiveReverifyDecision\(\s*verifiedPhoneRequired\(\)/,
    "the notice must derive its decision through effectiveReverifyDecision(verifiedPhoneRequired(), …)",
  );
});

test("e2e harness pins the flag ON so the TM-930/932/982 verify-flow specs stay meaningful", () => {
  const src = read("../e2e/serve.mjs");
  assert.match(
    src,
    /requireVerifiedPhone:\s*true/,
    "serve.mjs E2E config must pin requireVerifiedPhone: true (the flag-ON regression surface)",
  );
});
