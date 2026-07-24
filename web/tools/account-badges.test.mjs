// Tests for the account-state badge logic (TM-168, TM-911). Framework-free — Node's built-in test
// runner, same harness as auth-env.test.mjs / biometric-policy.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core: how the two verification flags (emailVerified / ageVerified) map to
// badge descriptors, and the two payload shapes — `accountState.emailVerified` nested + top-level
// `ageVerified`. The DOM renderer (renderAccountBadges) is a thin map over these descriptors, so
// testing the descriptors tests the behaviour without needing a DOM.
//
// TM-911 truth (see the two dedicated tests at the bottom):
//   - an UNKNOWN (null/undefined) verification status MEANS not verified → renders the "off" badge,
//     never a separate "unknown" chip;
//   - MFA is no longer a header badge (moved to the dedicated security section, TM-912).

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

test("all-verified: two 'ok' badges in order (email, age)", () => {
  const states = accountBadgeStates(me({ emailVerified: true, mfaEnabled: true, ageVerified: true }));
  assert.equal(states.length, 2);
  assert.deepEqual(
    states.map((s) => [s.key, s.state, s.variant, s.label]),
    [
      ["emailVerified", "on", "ok", "Email verified"],
      ["ageVerified", "on", "ok", "Age verified"],
    ],
  );
});

test("all-off: two 'off' badges with the not-verified labels", () => {
  const states = accountBadgeStates(me({ emailVerified: false, mfaEnabled: false, ageVerified: false }));
  assert.deepEqual(
    states.map((s) => [s.key, s.state, s.variant, s.label]),
    [
      ["emailVerified", "off", "off", "Email not verified"],
      ["ageVerified", "off", "off", "Age not verified"],
    ],
  );
});

test("null Firebase email flag reads as 'not verified' (off), not dropped (TM-911)", () => {
  // emailVerified unreadable (credential-free dev); ageVerified is our DB boolean.
  const states = accountBadgeStates(me({ emailVerified: null, mfaEnabled: null, ageVerified: false }));
  // Both badges present; the unknown email is rendered as the off / not-verified state.
  assert.equal(states.length, 2);
  const email = states.find((s) => s.key === "emailVerified");
  assert.equal(email.state, "off");
  assert.equal(email.label, "Email not verified");
});

test("includeUnknown is a no-op — unknown flags still render as 'not verified' (TM-911)", () => {
  const states = accountBadgeStates(me({ emailVerified: null, mfaEnabled: null, ageVerified: true }), {
    includeUnknown: true,
  });
  assert.equal(states.length, 2);
  assert.deepEqual(
    states.map((s) => [s.key, s.state, s.variant]),
    [
      ["emailVerified", "off", "off"],
      ["ageVerified", "on", "ok"],
    ],
  );
});

test("accessible labels prefix the field name (announced as 'Field: state')", () => {
  const states = accountBadgeStates(me({ emailVerified: true, mfaEnabled: false, ageVerified: true }));
  const byKey = Object.fromEntries(states.map((s) => [s.key, s.ariaLabel]));
  assert.equal(byKey.emailVerified, "Email: Email verified");
  assert.equal(byKey.ageVerified, "Age: Age verified");
});

test("empty / missing /me still yields both verification badges as 'not verified' (TM-911)", () => {
  // Nothing readable → every verification is, to the user, simply not verified.
  for (const input of [undefined, {}]) {
    const states = accountBadgeStates(input);
    assert.equal(states.length, 2);
    assert.deepEqual(
      states.map((s) => [s.key, s.state]),
      [
        ["emailVerified", "off"],
        ["ageVerified", "off"],
      ],
    );
  }
});

// --- TM-911: the two changes, guarded directly ---------------------------------------------------

test("TM-911: unknown (null/undefined) verification renders 'not verified', NEVER an 'unknown' chip", () => {
  // Cover both flags, both unknown shapes (null + undefined), and the includeUnknown path the profile
  // page uses. Before TM-911 these were the "…status unknown" / variant "unknown" descriptors.
  for (const opts of [{}, { includeUnknown: true }]) {
    const states = accountBadgeStates(
      me({ emailVerified: null, ageVerified: undefined }),
      opts,
    );
    for (const s of states) {
      assert.notEqual(s.state, "unknown", `${s.key} should not be 'unknown'`);
      assert.notEqual(s.variant, "unknown", `${s.key} should not have the 'unknown' variant`);
      assert.doesNotMatch(s.label, /unknown/i, `${s.key} label should not say 'unknown'`);
    }
    const email = states.find((s) => s.key === "emailVerified");
    const age = states.find((s) => s.key === "ageVerified");
    assert.equal(email.label, "Email not verified");
    assert.equal(age.label, "Age not verified");
  }
});

test("TM-911: the MFA badge is absent from the rendered badge set", () => {
  // Even with mfaEnabled explicitly set (either value) and includeUnknown forced, no MFA badge.
  for (const mfaEnabled of [true, false, null]) {
    for (const opts of [{}, { includeUnknown: true }]) {
      const states = accountBadgeStates(
        me({ emailVerified: true, mfaEnabled, ageVerified: true }),
        opts,
      );
      assert.ok(
        !states.some((s) => s.key === "mfaEnabled"),
        `mfa badge should be absent (mfaEnabled=${mfaEnabled}, opts=${JSON.stringify(opts)})`,
      );
      // Only the two verification badges remain, in order.
      assert.deepEqual(
        states.map((s) => s.key),
        ["emailVerified", "ageVerified"],
      );
    }
  }
});
