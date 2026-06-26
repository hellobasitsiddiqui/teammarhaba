// Tests for the biometric policy decisions (TM-282). Framework-free — Node's built-in test runner,
// same harness as auth-env.test.mjs / fingerprint.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the parts of the biometric layer that CANNOT be exercised in CI or a headless browser
// (there is no fingerprint sensor): "is the feature usable here?", "should the lock engage?", "is the
// stored setting on?", and how an auth-failure code maps to UI behaviour. The live bridge
// (biometric.js / biometric-lock.js) is a thin shell over these pure decisions.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_LOCK_KEY,
  USER_DISMISS_CODES,
  isBiometricUsable,
  isAppLockEnabled,
  setAppLockEnabled,
  shouldEngageLock,
  classifyAuthError,
} from "../src/assets/biometric-policy.js";

// A tiny in-memory localStorage-like stub.
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

test("isBiometricUsable: true when biometry is enrolled (isAvailable)", () => {
  assert.equal(isBiometricUsable({ isAvailable: true, deviceIsSecure: true }), true);
  assert.equal(isBiometricUsable({ isAvailable: true, deviceIsSecure: false }), true);
});

test("isBiometricUsable: device credential (PIN) counts when allowed and device is secure", () => {
  assert.equal(isBiometricUsable({ isAvailable: false, deviceIsSecure: true }, true), true);
  // ...but only if we allow device-credential fallback.
  assert.equal(isBiometricUsable({ isAvailable: false, deviceIsSecure: true }, false), false);
});

test("isBiometricUsable: false with no biometry and no secure lock screen (feature must hide)", () => {
  assert.equal(isBiometricUsable({ isAvailable: false, deviceIsSecure: false }), false);
});

test("isBiometricUsable: null/garbage input is safe (false, no throw)", () => {
  assert.equal(isBiometricUsable(null), false);
  assert.equal(isBiometricUsable(undefined), false);
  assert.equal(isBiometricUsable("nope"), false);
  assert.equal(isBiometricUsable({}), false);
});

test("isAppLockEnabled: defaults OFF when unset", () => {
  assert.equal(isAppLockEnabled(makeStorage()), false);
});

test("isAppLockEnabled: reads a stored 'true'/'false'", () => {
  assert.equal(isAppLockEnabled(makeStorage({ [APP_LOCK_KEY]: "true" })), true);
  assert.equal(isAppLockEnabled(makeStorage({ [APP_LOCK_KEY]: "false" })), false);
  // Any non-"true" value is OFF (fail safe).
  assert.equal(isAppLockEnabled(makeStorage({ [APP_LOCK_KEY]: "1" })), false);
});

test("isAppLockEnabled: missing/throwing storage fails safe to OFF", () => {
  assert.equal(isAppLockEnabled(null), false);
  assert.equal(isAppLockEnabled({}), false);
  const throwing = { getItem: () => { throw new Error("blocked"); } };
  assert.equal(isAppLockEnabled(throwing), false);
});

test("setAppLockEnabled: persists 'true'/'false' and returns true", () => {
  const s = makeStorage();
  assert.equal(setAppLockEnabled(s, true), true);
  assert.equal(s.getItem(APP_LOCK_KEY), "true");
  assert.equal(setAppLockEnabled(s, false), true);
  assert.equal(s.getItem(APP_LOCK_KEY), "false");
});

test("setAppLockEnabled: bad/throwing storage returns false (no throw)", () => {
  assert.equal(setAppLockEnabled(null, true), false);
  const throwing = { setItem: () => { throw new Error("blocked"); } };
  assert.equal(setAppLockEnabled(throwing, true), false);
});

test("shouldEngageLock: only when native AND enabled AND usable", () => {
  assert.equal(shouldEngageLock({ isNative: true, lockEnabled: true, biometryUsable: true }), true);
  assert.equal(shouldEngageLock({ isNative: false, lockEnabled: true, biometryUsable: true }), false);
  assert.equal(shouldEngageLock({ isNative: true, lockEnabled: false, biometryUsable: true }), false);
  assert.equal(shouldEngageLock({ isNative: true, lockEnabled: true, biometryUsable: false }), false);
});

test("classifyAuthError: user-dismiss codes → 'dismissed'", () => {
  for (const code of USER_DISMISS_CODES) {
    assert.equal(classifyAuthError(code), "dismissed");
  }
});

test("classifyAuthError: no biometry/credential on device → 'unavailable' (fail open)", () => {
  assert.equal(classifyAuthError("biometryNotAvailable"), "unavailable");
  assert.equal(classifyAuthError("biometryNotEnrolled"), "unavailable");
  assert.equal(classifyAuthError("noDeviceCredential"), "unavailable");
  assert.equal(classifyAuthError("passcodeNotSet"), "unavailable");
});

test("classifyAuthError: lockout → 'failed' (stay locked, TM-292)", () => {
  // A temporary OS lockout is NOT "unavailable" — the credential still exists, so failing open would
  // let anyone bypass the lock by deliberately failing biometry a few times. Stay locked.
  assert.equal(classifyAuthError("biometryLockout"), "failed");
});

test("classifyAuthError: genuine non-match / unknown → 'failed'", () => {
  assert.equal(classifyAuthError("authenticationFailed"), "failed");
  assert.equal(classifyAuthError("somethingElse"), "failed");
  assert.equal(classifyAuthError(""), "failed");
});
