// Tests for the account-state badge logic (TM-168, TM-911, TM-1093). Framework-free — Node's built-in
// test runner, same harness as auth-env.test.mjs / biometric-policy.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the PURE core: how the verification flags map to badge descriptors, and the two payload
// shapes — `accountState.emailVerified` nested + top-level `ageVerified`. The DOM renderer
// (renderAccountBadges) is a thin map over these descriptors, so testing the descriptors tests the
// behaviour without needing a DOM.
//
// Truth guarded here:
//   - TM-911: an UNKNOWN (null/undefined) verification status MEANS not verified → renders the "off"
//     badge, never a separate "unknown" chip; MFA is not a header badge (moved to TM-912).
//   - TM-1093: the "Age verified" badge is REMOVED. `ageVerified` is only a self-attested age, so a
//     green "Age verified" chip mis-claimed real verification we don't have yet (TM-875). Only the
//     Email badge renders. The `ageVerified` flag is still EXTRACTED (extractAccountFlags) so the
//     badge can be re-added when TM-875 ships.

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

// extractAccountFlags is UNCHANGED by TM-1093 — the age flag is still read from the payload (so the
// badge is a one-line re-add once real verification exists), it's just no longer rendered.
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

test("verified: a single 'ok' Email badge (TM-1093 removed the Age badge)", () => {
  const states = accountBadgeStates(me({ emailVerified: true, mfaEnabled: true, ageVerified: true }));
  assert.equal(states.length, 1);
  assert.deepEqual(
    states.map((s) => [s.key, s.state, s.variant, s.label]),
    [["emailVerified", "on", "ok", "Email verified"]],
  );
});

test("not-verified: a single 'off' Email badge", () => {
  const states = accountBadgeStates(me({ emailVerified: false, mfaEnabled: false, ageVerified: false }));
  assert.deepEqual(
    states.map((s) => [s.key, s.state, s.variant, s.label]),
    [["emailVerified", "off", "off", "Email not verified"]],
  );
});

test("null Firebase email flag reads as 'not verified' (off), not dropped (TM-911)", () => {
  // emailVerified unreadable (credential-free dev).
  const states = accountBadgeStates(me({ emailVerified: null, mfaEnabled: null, ageVerified: false }));
  assert.equal(states.length, 1);
  const email = states.find((s) => s.key === "emailVerified");
  assert.equal(email.state, "off");
  assert.equal(email.label, "Email not verified");
});

test("includeUnknown is a no-op — unknown email still renders as 'not verified' (TM-911)", () => {
  const states = accountBadgeStates(me({ emailVerified: null, mfaEnabled: null, ageVerified: true }), {
    includeUnknown: true,
  });
  assert.equal(states.length, 1);
  assert.deepEqual(
    states.map((s) => [s.key, s.state, s.variant]),
    [["emailVerified", "off", "off"]],
  );
});

test("accessible label prefixes the field name (announced as 'Field: state')", () => {
  const states = accountBadgeStates(me({ emailVerified: true, mfaEnabled: false, ageVerified: true }));
  const byKey = Object.fromEntries(states.map((s) => [s.key, s.ariaLabel]));
  assert.equal(byKey.emailVerified, "Email: Email verified");
});

test("empty / missing /me still yields the Email badge as 'not verified' (TM-911)", () => {
  // Nothing readable → the verification is, to the user, simply not verified.
  for (const input of [undefined, {}]) {
    const states = accountBadgeStates(input);
    assert.equal(states.length, 1);
    assert.deepEqual(
      states.map((s) => [s.key, s.state]),
      [["emailVerified", "off"]],
    );
  }
});

// --- TM-911: unknown → not verified, never an 'unknown' chip --------------------------------------

test("TM-911: unknown (null/undefined) verification renders 'not verified', NEVER an 'unknown' chip", () => {
  for (const opts of [{}, { includeUnknown: true }]) {
    const states = accountBadgeStates(me({ emailVerified: null, ageVerified: undefined }), opts);
    for (const s of states) {
      assert.notEqual(s.state, "unknown", `${s.key} should not be 'unknown'`);
      assert.notEqual(s.variant, "unknown", `${s.key} should not have the 'unknown' variant`);
      assert.doesNotMatch(s.label, /unknown/i, `${s.key} label should not say 'unknown'`);
    }
    const email = states.find((s) => s.key === "emailVerified");
    assert.equal(email.label, "Email not verified");
  }
});

test("TM-911: the MFA badge is absent from the rendered badge set", () => {
  for (const mfaEnabled of [true, false, null]) {
    for (const opts of [{}, { includeUnknown: true }]) {
      const states = accountBadgeStates(me({ emailVerified: true, mfaEnabled, ageVerified: true }), opts);
      assert.ok(
        !states.some((s) => s.key === "mfaEnabled"),
        `mfa badge should be absent (mfaEnabled=${mfaEnabled}, opts=${JSON.stringify(opts)})`,
      );
    }
  }
});

// --- TM-1093: the Age badge is removed (self-attested age must not read as "verified") ------------

test("TM-1093: NO 'Age verified' badge is rendered, for any ageVerified value or option", () => {
  // Whatever the (self-attested) age flag says, and whichever call path the profile/admin pages use,
  // the age badge must not appear — it falsely implied real verification (TM-875 is the real thing).
  for (const ageVerified of [true, false, null, undefined]) {
    for (const opts of [{}, { includeUnknown: true }]) {
      const states = accountBadgeStates(me({ emailVerified: true, ageVerified }), opts);
      assert.ok(
        !states.some((s) => s.key === "ageVerified"),
        `age badge should be absent (ageVerified=${ageVerified}, opts=${JSON.stringify(opts)})`,
      );
      for (const s of states) {
        assert.doesNotMatch(s.label, /age/i, `no badge label should mention age (got "${s.label}")`);
      }
      // Only the Email badge remains, and it's the sole descriptor.
      assert.deepEqual(states.map((s) => s.key), ["emailVerified"]);
    }
  }
});
