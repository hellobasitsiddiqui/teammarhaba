// Native splash-screen environment detection (TM-299) — the pure, browser-free half of the splash
// client. Split out of splash.js for the same reason push-env.js was split out of push.js: this is
// the piece of the splash wiring that is unit-testable WITHOUT a browser or the Capacitor runtime —
// feed it a fake `window`, assert the gate — so `node --test web/tools/*.test.mjs` (the PR gate) can
// guard the "only touch the native splash inside the shell, stay inert on the web" contract. This
// module has zero Capacitor/Firebase imports.
//
// Why the gate matters: the SAME hosted web SPA is served to a normal browser AND loaded inside the
// Capacitor Android shell (TM-278) from the same URL. The native splash plugin only exists in the
// shell; on the browser/PWA build there's no native splash to hide, so the whole thing must no-op.
//
// HOW THE PLUGIN IS REACHED. There's no bundler here (the SPA is hosted), so we can't `import`
// `@capacitor/splash-screen` (a build-time node_modules package — it exists only so `cap sync`
// compiles the NATIVE half into the APK). Capacitor injects the plugin proxy onto
// `window.Capacitor.Plugins.SplashScreen` at runtime inside the WebView; that's where we read it.

/**
 * The Capacitor SplashScreen plugin proxy, or null when not running inside the native shell.
 *
 * A plain browser has no `window.Capacitor`, and even where a partial Capacitor global exists,
 * `isNativePlatform()` is false on web — both cases return null so every caller short-circuits.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {object|null} the SplashScreen plugin, or null when unavailable.
 */
export function getSplashPlugin(win = globalThis) {
  const cap = win && win.Capacitor;
  if (!cap) return null;
  // Only the native runtime carries the plugin; on web `isNativePlatform()` is false.
  if (typeof cap.isNativePlatform === "function" && !cap.isNativePlatform()) return null;
  const plugin = cap.Plugins && cap.Plugins.SplashScreen;
  return plugin || null;
}

/**
 * Is there a native splash to manage in this environment? True ONLY inside the native shell — the
 * Capacitor native runtime + SplashScreen plugin are injected. False on the browser/PWA build, so
 * splash.js stays completely inert there (no plugin call).
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean}
 */
export function isSplashSupported(win = globalThis) {
  return getSplashPlugin(win) !== null;
}
