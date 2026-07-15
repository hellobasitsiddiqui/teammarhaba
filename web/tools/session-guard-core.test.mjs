// Tests for the session-guard core (TM-720). Framework-free — Node's built-in test runner, picked up
// by the CI glob `node --test web/tools/*.test.mjs`.
//
// session-guard-core.js has zero DOM/Firebase deps, so the whole cross-user / stale-response logic is
// assertable here: reducing an auth user to a session key, deciding whether an in-flight /me response
// is still safe to apply (same user still signed in), and detecting a sign-out.

import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionKey, isResponseCurrent, isSignedOut } from "../src/assets/session-guard-core.js";

test("sessionKey: reduces a Firebase user / bare uid / null to a uid or null", () => {
  assert.equal(sessionKey({ uid: "u1" }), "u1", "User object → its uid");
  assert.equal(sessionKey("u2"), "u2", "bare uid string → itself");
  assert.equal(sessionKey(null), null, "signed out → null");
  assert.equal(sessionKey(undefined), null, "undefined → null");
  assert.equal(sessionKey({}), null, "user with no uid → null");
  assert.equal(sessionKey(""), null, "empty string → null");
});

test("isResponseCurrent: apply only when the SAME user is still signed in", () => {
  assert.equal(isResponseCurrent("u1", "u1"), true, "same user → apply");
  assert.equal(isResponseCurrent("u1", null), false, "signed out mid-flight → drop (banner-over-login)");
  assert.equal(isResponseCurrent("u1", "u2"), false, "switched user → drop (cross-user leak)");
  assert.equal(isResponseCurrent(null, "u2"), false, "started signed-out → never apply an anon /me");
  assert.equal(isResponseCurrent(null, null), false, "both null → drop");
});

test("isSignedOut: true for any auth change to no active user", () => {
  assert.equal(isSignedOut(null), true, "null user → signed out");
  assert.equal(isSignedOut(undefined), true, "undefined → signed out");
  assert.equal(isSignedOut({}), true, "user without uid → treated as no user");
  assert.equal(isSignedOut({ uid: "u1" }), false, "a real user → not signed out");
  assert.equal(isSignedOut("u1"), false, "a bare uid → not signed out");
});
