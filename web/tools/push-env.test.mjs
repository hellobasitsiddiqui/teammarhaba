// Tests for the push environment detection (TM-279). Framework-free — Node's built-in test runner,
// same harness as auth-env.test.mjs and picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Guards the core TM-279 contract: push wires up ONLY inside the Capacitor native shell (WebView
// signal present AND the native Capacitor runtime + PushNotifications plugin injected), and is
// completely inert on the browser/PWA build — so the web experience never sees a permission prompt or
// a plugin call. push.js itself can't be imported here (it pulls in the Firebase SDK from a CDN URL
// via auth.js), which is exactly why the gate lives in the Firebase-free push-env.js.

import assert from "node:assert/strict";
import { test } from "node:test";

import { getPushPlugin, isPushSupported } from "../src/assets/push-env.js";

/** A fake PushNotifications plugin proxy (its shape doesn't matter to the gate). */
const fakePlugin = { register() {}, addListener() {}, checkPermissions() {}, requestPermissions() {} };

/** Build a fake `window` for the gate. */
function makeWin({ webView = false, native = undefined, plugin = undefined } = {}) {
  const win = {};
  if (webView) win.TEAMMARHABA_WEBVIEW = true;
  if (native !== undefined || plugin !== undefined) {
    win.Capacitor = {
      isNativePlatform: native === undefined ? undefined : () => native,
      Plugins: plugin ? { PushNotifications: plugin } : {},
    };
  }
  return win;
}

test("plain browser (no Capacitor, no WebView signal) is not push-supported", () => {
  const win = makeWin();
  assert.equal(getPushPlugin(win), null);
  assert.equal(isPushSupported(win), false);
});

test("getPushPlugin returns null when Capacitor reports non-native (web build)", () => {
  const win = makeWin({ webView: true, native: false, plugin: fakePlugin });
  assert.equal(getPushPlugin(win), null);
  assert.equal(isPushSupported(win), false);
});

test("getPushPlugin returns null when the plugin is not injected", () => {
  const win = makeWin({ webView: true, native: true });
  assert.equal(getPushPlugin(win), null);
  assert.equal(isPushSupported(win), false);
});

test("getPushPlugin returns the plugin inside the native shell", () => {
  const win = makeWin({ webView: true, native: true, plugin: fakePlugin });
  assert.equal(getPushPlugin(win), fakePlugin);
});

test("native shell with the WebView signal IS push-supported", () => {
  const win = makeWin({ webView: true, native: true, plugin: fakePlugin });
  assert.equal(isPushSupported(win), true);
});

test("native runtime + plugin but NO WebView signal is not push-supported", () => {
  // Defence-in-depth: the WebView env signal is required as well, matching the auth gate.
  const win = makeWin({ webView: false, native: true, plugin: fakePlugin });
  assert.equal(getPushPlugin(win), fakePlugin);
  assert.equal(isPushSupported(win), false);
});
