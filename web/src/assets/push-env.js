// Push-notifications environment detection (TM-279) — the pure, browser-free half of the push client.
//
// Split out of push.js for the same reason auth-env.js was split out of auth.js: this is the one
// piece of the push wiring that is unit-testable WITHOUT a browser, the Capacitor runtime, or the
// Firebase SDK. push.js imports the Firebase SDK (transitively via auth.js) from a gstatic CDN URL,
// which the Node test runner can't load — so the "only run push inside the native shell, stay inert
// on the web" contract would be untestable if it lived there. Here it's pure given its `win` input,
// so `node --test web/tools/*.test.mjs` (the PR gate) can feed it a fake `window` and assert the
// gate. This module has zero Firebase/Capacitor imports.
//
// Why the gate matters: the same web SPA is served to a normal browser AND loaded inside the
// Capacitor Android shell (TM-278) from the same hosted URL. Push must do real work ONLY in the
// native shell and be completely inert on the browser/PWA build (no permission prompt, no plugin
// call), or the web experience regresses.

import { isWebViewEnv } from "./auth-env.js";

/**
 * The Capacitor PushNotifications plugin proxy, or null when not running inside the native shell.
 *
 * Because the web app has no bundler, we can't `import` `@capacitor/push-notifications` (a build-time
 * node_modules package). Capacitor injects the plugin proxies onto `window.Capacitor.Plugins` at
 * runtime inside the WebView, so that's where we read it. A plain browser has no `window.Capacitor`,
 * and even where a partial Capacitor global exists, `isNativePlatform()` is false on web — both cases
 * return null so every caller short-circuits.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {object|null} the PushNotifications plugin, or null when unavailable.
 */
export function getPushPlugin(win = globalThis) {
  const cap = win && win.Capacitor;
  if (!cap) return null;
  // Only the native runtime carries the plugin; on web `isNativePlatform()` is false.
  if (typeof cap.isNativePlatform === "function" && !cap.isNativePlatform()) return null;
  const plugin = cap.Plugins && cap.Plugins.PushNotifications;
  return plugin || null;
}

/**
 * Should push be wired in this environment? True ONLY inside the native shell — the WebView signal is
 * present (auth-env's `isWebViewEnv`) AND the Capacitor native runtime + PushNotifications plugin are
 * injected. False on the browser/PWA build, so push.js stays completely inert there.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean}
 */
export function isPushSupported(win = globalThis) {
  return isWebViewEnv(win) && getPushPlugin(win) !== null;
}

/** The device-platform values the backend accepts (com.teammarhaba.backend.device.DevicePlatform)
 * and `api.js registerDevice` is typed for. `WEB` is the safe fallback for any surface that isn't a
 * recognised native shell (it's inert anyway — push only registers where `isPushSupported`). */
export const DEVICE_PLATFORM = Object.freeze({ IOS: "IOS", ANDROID: "ANDROID", WEB: "WEB" });

/**
 * Which `DevicePlatform` this device registers as. Derived from Capacitor's own `getPlatform()` so a
 * device reports the shell it actually runs in — `'ios'`→`'IOS'` (WKWebView shell, TM-348),
 * `'android'`→`'ANDROID'` (TM-278), everything else (incl. Capacitor's own `'web'`, or no Capacitor
 * global at all)→`'WEB'`. This replaces the old hard-coded `ANDROID` in push.js now that iOS is a
 * real shell: the token a device sends and the platform it claims must match, or the send-push
 * service (TM-284) would route an APNs token down the Android/FCM path.
 *
 * Pure given `win` (reads only `Capacitor.getPlatform`), so it's unit-testable under `node --test`
 * here in the Firebase-free module — push.js itself can't be imported by the test runner.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {"IOS"|"ANDROID"|"WEB"}
 */
export function platformFor(win = globalThis) {
  const cap = win && win.Capacitor;
  const name = cap && typeof cap.getPlatform === "function" ? cap.getPlatform() : null;
  switch (name) {
    case "ios":
      return DEVICE_PLATFORM.IOS;
    case "android":
      return DEVICE_PLATFORM.ANDROID;
    default:
      return DEVICE_PLATFORM.WEB;
  }
}
