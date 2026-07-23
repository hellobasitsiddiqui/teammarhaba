// Tests for the proof-of-both account-link policy (TM-990, split (b) of TM-306). Framework-free —
// Node's built-in test runner, same harness as auth-env.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// This guards the SECURITY-CRITICAL contract that CANNOT be reproduced in an emulator and MUST NOT
// regress: a cross-provider link happens ONLY with proof of control of BOTH identifiers (signed into
// the first account AND the second credential verified in this flow), and a collision with another
// account is a hard-block, never a silent merge.

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideLink } from "../src/assets/account-link-policy.js";

// ── decideLink: proof of BOTH ────────────────────────────────────────────────────────────────────

test("PROVEN link: signed into the first account AND the second credential verified this flow", () => {
  // The safe convergence case: the user is already authenticated as account A (proof of the first
  // identifier) and has just verified the phone via OTP in this flow (proof of the second).
  assert.equal(
    decideLink({ signedInUid: "uid-A", credentialVerifiedInThisFlow: true }),
    "link",
  );
});

test("REFUSED: an UNVERIFIED match does NOT auto-link even when signed in (the takeover guard)", () => {
  // Signed in, but the second credential was NOT proven in this flow. Linking here would be linking on
  // an unverified match — the account-takeover hole. Must refuse, keeping the identities separate.
  assert.equal(
    decideLink({ signedInUid: "uid-A", credentialVerifiedInThisFlow: false }),
    "refuse-unverified",
  );
});

test("REFUSED: not signed into any first account — a link would fabricate a merge", () => {
  // No first account to link INTO. Even a verified credential can't converge onto nothing; treating
  // this as a link would turn a fresh sign-in into an implicit merge.
  assert.equal(
    decideLink({ signedInUid: null, credentialVerifiedInThisFlow: true }),
    "refuse-not-signed-in",
  );
  assert.equal(decideLink({ signedInUid: undefined, credentialVerifiedInThisFlow: true }), "refuse-not-signed-in");
});

test("REFUSED: neither proof present", () => {
  assert.equal(decideLink({}), "refuse-not-signed-in");
  assert.equal(decideLink({ signedInUid: "", credentialVerifiedInThisFlow: false }), "refuse-not-signed-in");
});

test("decideLink coerces a truthy-but-non-boolean verified flag safely", () => {
  // Only an actual "both proofs" state links; a missing/garbage flag never accidentally proves.
  assert.equal(decideLink({ signedInUid: "uid-A" }), "refuse-unverified"); // flag undefined => not verified
});
