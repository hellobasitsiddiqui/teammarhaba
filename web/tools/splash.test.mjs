// Tests for the native splash driver (TM-299). Framework-free — Node's built-in test runner, picked
// up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Importing splash.js runs its module-level `initSplash()` against the real globalThis — which in Node
// has no `window.Capacitor`, so it's a complete no-op (proving the off-device inertness contract). We
// then drive `hideSplash` with an injected fake `window` to assert: it no-ops off-device, hides via
// the plugin inside the shell, and is idempotent (only the first call issues a hide).

import assert from "node:assert/strict";
import { test } from "node:test";

import { hideSplash } from "../src/assets/splash.js";

/** A fake `window` exposing a Capacitor SplashScreen plugin that records hide() calls. */
function makeNativeWin() {
  const calls = [];
  const win = {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: { SplashScreen: { hide: async (opts) => calls.push(opts) } },
    },
  };
  return { win, calls };
}

test("hideSplash is a no-op off-device (no native plugin)", async () => {
  const issued = await hideSplash({}); // plain browser-ish window, no Capacitor
  assert.equal(issued, false);
});

test("hideSplash hides via the plugin once, then is idempotent", async () => {
  const { win, calls } = makeNativeWin();
  const first = await hideSplash(win);
  const second = await hideSplash(win);
  assert.equal(first, true, "first call issues the hide");
  assert.equal(second, false, "second call is a no-op (already hidden)");
  assert.equal(calls.length, 1, "the native plugin hide() is called exactly once");
});
