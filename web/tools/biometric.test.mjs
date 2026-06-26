// Tests for the biometric bridge dispatch (TM-282 / TM-300). Framework-free — Node's built-in test
// runner, same harness as biometric-policy.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// These guard the ONE piece of biometric.js that can be exercised without a fingerprint sensor: which
// native method we dispatch to, and how a plugin rejection maps to our flat { ok, reason, code }
// result. This is exactly where TM-300 bit — the code called the JS-only `authenticate()` wrapper,
// which isn't exposed over the native bridge (only `internalAuthenticate` is), so on device it hit the
// "no prompt method" guard and silently passed through without ever prompting.
//
// biometric.js reads the plugin off a `win.Capacitor` we pass in, so we can simulate the native shell
// with a stub and never touch a real device.

import assert from "node:assert/strict";
import { test } from "node:test";

import { getAuthenticateFn, authenticate, getPlugin, isNativeShell } from "../src/assets/biometric.js";

// A fake window whose Capacitor mimics the NATIVE bridge: isNativePlatform() === true and only the
// bridged @PluginMethod methods present on the plugin.
function nativeWin(plugin) {
  return {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: { BiometricAuthNative: plugin },
    },
  };
}

test("getAuthenticateFn: prefers the bridged internalAuthenticate", () => {
  const calls = [];
  const plugin = {
    internalAuthenticate: function (o) { calls.push(["internal", o]); return Promise.resolve(); },
    authenticate: function (o) { calls.push(["wrapper", o]); return Promise.resolve(); },
  };
  const fn = getAuthenticateFn(plugin);
  fn({ reason: "x" });
  assert.equal(calls[0][0], "internal");
});

test("getAuthenticateFn: falls back to authenticate when no internalAuthenticate (web simulator)", () => {
  const calls = [];
  const plugin = { authenticate: function (o) { calls.push(["wrapper", o]); return Promise.resolve(); } };
  const fn = getAuthenticateFn(plugin);
  assert.equal(typeof fn, "function");
  fn({ reason: "x" });
  assert.equal(calls[0][0], "wrapper");
});

test("getAuthenticateFn: null/garbage plugin → null (no throw)", () => {
  assert.equal(getAuthenticateFn(null), null);
  assert.equal(getAuthenticateFn(undefined), null);
  assert.equal(getAuthenticateFn({}), null);
  assert.equal(getAuthenticateFn({ authenticate: "nope" }), null);
});

test("isNativeShell/getPlugin: false/null in a plain browser (no Capacitor)", () => {
  assert.equal(isNativeShell({}), false);
  assert.equal(getPlugin({}), null);
});

test("authenticate: TM-300 regression — calls internalAuthenticate on the native bridge and resolves ok", async () => {
  let received = null;
  const plugin = {
    // This is the ONLY prompt method exposed over the native bridge.
    internalAuthenticate: function (opts) { received = opts; return Promise.resolve(); },
    // NOTE: deliberately NO `authenticate` here — that's the real on-device shape, and the old code
    // would have silently passed through.
  };
  const res = await authenticate({ reason: "Unlock", title: "Unlock", subtitle: "go" }, nativeWin(plugin));
  assert.deepEqual(res, { ok: true });
  // Option keys must match the native @PluginMethod contract.
  assert.equal(received.reason, "Unlock");
  assert.equal(received.androidTitle, "Unlock");
  assert.equal(received.androidSubtitle, "go");
  assert.equal(received.cancelTitle, "Cancel");
  assert.equal(received.allowDeviceCredential, true);
});

test("authenticate: allowDeviceCredential can be turned off explicitly", async () => {
  let received = null;
  const plugin = { internalAuthenticate: (o) => { received = o; return Promise.resolve(); } };
  await authenticate({ reason: "x", allowDeviceCredential: false }, nativeWin(plugin));
  assert.equal(received.allowDeviceCredential, false);
});

test("authenticate: a native reject maps via classifyAuthError (userCancel → dismissed)", async () => {
  const plugin = {
    internalAuthenticate: () => Promise.reject(Object.assign(new Error("cancelled"), { code: "userCancel" })),
  };
  const res = await authenticate({ reason: "x" }, nativeWin(plugin));
  assert.deepEqual(res, { ok: false, reason: "dismissed", code: "userCancel" });
});

test("authenticate: biometryLockout → failed (stay locked, TM-292)", async () => {
  // A temporary OS lockout must NOT fail open — the credential still exists, so unlocking on it would
  // let anyone bypass the app-lock by deliberately failing biometry a few times. Stay locked.
  const plugin = {
    internalAuthenticate: () => Promise.reject(Object.assign(new Error("lockout"), { code: "biometryLockout" })),
  };
  const res = await authenticate({ reason: "x" }, nativeWin(plugin));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "failed");
  assert.equal(res.code, "biometryLockout");
});

test("authenticate: a genuine non-match (authenticationFailed) → failed", async () => {
  const plugin = {
    internalAuthenticate: () => Promise.reject(Object.assign(new Error("no match"), { code: "authenticationFailed" })),
  };
  const res = await authenticate({ reason: "x" }, nativeWin(plugin));
  assert.equal(res.reason, "failed");
});

test("authenticate: a reject with no string code → failed (safe default)", async () => {
  const plugin = { internalAuthenticate: () => Promise.reject(new Error("boom")) };
  const res = await authenticate({ reason: "x" }, nativeWin(plugin));
  assert.equal(res.reason, "failed");
  assert.equal(res.code, "failed");
});

test("authenticate: not in the native shell → passes through (web unaffected — ok:true)", async () => {
  const res = await authenticate({ reason: "x" }, {}); // no Capacitor
  assert.deepEqual(res, { ok: true, reason: "not-native" });
});

test("authenticate: native shell but plugin exposes no prompt method → passes through", async () => {
  // e.g. plugin somehow registered checkBiometry only. Never block the action; backend is the gate.
  const res = await authenticate({ reason: "x" }, nativeWin({ checkBiometry: () => Promise.resolve({}) }));
  assert.deepEqual(res, { ok: true, reason: "not-native" });
});
