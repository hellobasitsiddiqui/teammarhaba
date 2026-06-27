// Tests for the account-state badge logic (TM-168). Framework-free — Node's built-in test runner,
// same harness as auth-env.test.mjs / biometric-policy.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core: how the three /me flags (emailVerified / ageVerified / mfaEnabled) map
// to badge descriptors, including the tri-state handling (on / off / unknown) and the two payload
// shapes — `accountState.{emailVerified,mfaEnabled}` nested + top-level `ageVerified`. The DOM
// renderer (renderAccountBadges) is a thin map over these descriptors, so testing the descriptors
// tests the behaviour without needing a DOM.

import assert from "node:assert/strict";
import { test } from "node:test";

import { accountBadgeStates, extractAccountFlags } from "../src/assets/account-badges.js";

// A realistic /me payload (the shape MeResponse serialises to): emailVerified/mfaEnabled nested
// under accountState, ageVerified at the top level.
function me({ emailVerified, mfaEnabled, ageVerified } = {}) {
  return {
    uid: "abc",
    email: "a@b.com",
    ageVerified: ageVerified ?? false,
    accountState: { emailVerified, mfaEnabled, phoneVerified: null, photoURL: null, lastLoginAt: null },
  };
}

test("extractAccountFlags reads nested accountState + top-level ageVerified", () => {
  const flags = extractAccountFlags(me({ emailVerified: true, mfaEnabled: false, ageVerified: true }));
  assert.deepEqual(flags, { emailVerified: true, ageVerified: true, mfaEnabled: false });
});

test("extractAccountFlags falls back to flat flags (admin projection shape)", () => {
  const flags = extractAccountFlags({ emailVerified: true, ageVerified: false, mfaEnabled: true });
  assert.deepEqual(flags, { emailVerified: true, ageVerified: false, mfaEnabled: true });
});

test("extractAccountFlags tolerates null/undefined input", () => {
  assert.deepEqual(extractAccountFlags(null), {
    emailVerified: undefined,
    ageVerified: undefined,
    mfaEnabled: undefined,
  });
});

test("all-verified: three 'ok' badges in order", () => {
  const states = accountBadgeStates(me({ emailVerified: true, mfaEnabled: true, ageVerified: true }));
  assert.equal(states.length, 3);
  assert.deepEqual(
    states.map((s) => [s.key, s.state, s.variant, s.label]),
    [
      ["emailVerified", "on", "ok", "Email verified"],
      ["ageVerified", "on", "ok", "Age verified"],
      ["mfaEnabled", "on", "ok", "MFA on"],
    ],
  );
});

test("all-off: three 'off' badges with the not-verified / off labels", () => {
  const states = accountBadgeStates(me({ emailVerified: false, mfaEnabled: false, ageVerified: false }));
  assert.deepEqual(
    states.map((s) => [s.state, s.variant, s.label]),
    [
      ["off", "off", "Email not verified"],
      ["off", "off", "Age not verified"],
      ["off", "off", "MFA off"],
    ],
  );
});

test("null Firebase flags are 'unknown', not 'off' — omitted by default", () => {
  // emailVerified + mfaEnabled unreadable (credential-free dev); ageVerified is our DB boolean.
  const states = accountBadgeStates(me({ emailVerified: null, mfaEnabled: null, ageVerified: false }));
  // Only the age badge survives (the two unknowns are dropped).
  assert.equal(states.length, 1);
  assert.equal(states[0].key, "ageVerified");
  assert.equal(states[0].state, "off");
});

test("includeUnknown:true keeps unknown flags as neutral 'unknown' badges", () => {
  const states = accountBadgeStates(me({ emailVerified: null, mfaEnabled: null, ageVerified: true }), {
    includeUnknown: true,
  });
  assert.equal(states.length, 3);
  assert.deepEqual(
    states.map((s) => [s.key, s.state, s.variant]),
    [
      ["emailVerified", "unknown", "unknown"],
      ["ageVerified", "on", "ok"],
      ["mfaEnabled", "unknown", "unknown"],
    ],
  );
});

test("accessible labels prefix the field name (announced as 'Field: state')", () => {
  const states = accountBadgeStates(me({ emailVerified: true, mfaEnabled: false, ageVerified: true }));
  const byKey = Object.fromEntries(states.map((s) => [s.key, s.ariaLabel]));
  assert.equal(byKey.emailVerified, "Email: Email verified");
  assert.equal(byKey.ageVerified, "Age: Age verified");
  assert.equal(byKey.mfaEnabled, "Two-factor authentication: MFA off");
});

test("empty / missing /me yields no badges by default, three unknowns when forced", () => {
  assert.equal(accountBadgeStates(undefined).length, 0);
  assert.equal(accountBadgeStates({}).length, 0);
  assert.equal(accountBadgeStates({}, { includeUnknown: true }).length, 3);
});
