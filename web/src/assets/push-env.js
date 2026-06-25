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
