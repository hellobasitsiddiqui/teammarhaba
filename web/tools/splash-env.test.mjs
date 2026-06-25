// Tests for the native splash-screen environment detection (TM-299). Framework-free — Node's built-in
// test runner, same harness as push-env.test.mjs and picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// Guards the core TM-299 contract: the native splash is managed ONLY inside the Capacitor native shell
// (the native runtime + SplashScreen plugin injected), and is completely inert on the browser/PWA
// build — so the web experience never makes a plugin call. splash.js itself isn't imported here (it
// auto-inits against globalThis); the gate it relies on lives in the Capacitor-free splash-env.js,
// which is what we exercise.

import assert from "node:assert/strict";
import { test } from "node:test";

import { getSplashPlugin, isSplashSupported } from "../src/assets/splash-env.js";

/** A fake SplashScreen plugin proxy (its shape doesn't matter to the gate). */
const fakePlugin = { show() {}, hide() {} };

/** Build a fake `window` for the gate. */
function makeWin({ native = undefined, plugin = undefined } = {}) {
  const win = {};
  if (native !== undefined || plugin !== undefined) {
    win.Capacitor = {
      isNativePlatform: native === undefined ? undefined : () => native,
      Plugins: plugin ? { SplashScreen: plugin } : {},
    };
  }
  return win;
}

test("plain browser (no Capacitor) has no splash to manage", () => {
  const win = makeWin();
  assert.equal(getSplashPlugin(win), null);
  assert.equal(isSplashSupported(win), false);
});

test("getSplashPlugin returns null when Capacitor reports non-native (web build)", () => {
  const win = makeWin({ native: false, plugin: fakePlugin });
  assert.equal(getSplashPlugin(win), null);
  assert.equal(isSplashSupported(win), false);
});

test("getSplashPlugin returns null when the plugin is not injected", () => {
  const win = makeWin({ native: true });
  assert.equal(getSplashPlugin(win), null);
  assert.equal(isSplashSupported(win), false);
});

test("getSplashPlugin returns the plugin inside the native shell", () => {
  const win = makeWin({ native: true, plugin: fakePlugin });
  assert.equal(getSplashPlugin(win), fakePlugin);
});

test("native shell IS splash-supported", () => {
  const win = makeWin({ native: true, plugin: fakePlugin });
  assert.equal(isSplashSupported(win), true);
});
