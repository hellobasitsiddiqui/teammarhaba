// Native splash-screen driver (TM-299) — hides the native launch splash once the hosted web UI has
// actually painted, so the splash covers the REAL load (the network fetch of the hosted SPA) with no
// premature white flash and no fixed timer.
//
// CONTEXT. The Capacitor Android shell (TM-278) loads the hosted SPA over the network via
// `server.url`, so on cold launch there's a blank/white gap while the page is fetched and rendered.
// A native splash (configured in capacitor.config.json with `launchAutoHide: false`) covers that gap;
// because auto-hide is OFF, the WEB layer owns hiding it — which is what this module does, on the
// real first-paint signal rather than a timer, so it never uncovers a still-blank page.
//
// OFF-DEVICE. On any normal browser/PWA build there's no native splash (no `window.Capacitor`
// SplashScreen plugin), so `isSplashSupported()` is false and `hideSplash()` is a complete no-op —
// the web experience is entirely unaffected. The gate + plugin lookup live in the Capacitor-free,
// unit-testable splash-env.js (mirrors push-env.js).
//
// NO PLUGIN IMPORT. There's no bundler (the SPA is hosted), so we reach the plugin through the
// runtime-injected `window.Capacitor.Plugins.SplashScreen` proxy — see native-camera.js / push.js for
// the same pattern. The npm dep exists only so `cap sync` compiles the native half into the APK.

import { getSplashPlugin } from "./splash-env.js";

let hidden = false;

/**
 * Hide the native splash, once. No-op off-device (no native SplashScreen plugin) and idempotent, so
 * it's safe to call from more than one ready signal. Swallows any plugin error: failing to hide the
 * splash must never break boot — the plugin also can't leave a permanent splash because the native
 * side has its own fade, but we drive the hide on real readiness for a clean handoff.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {Promise<boolean>} true if a hide was issued to the native plugin, false if it no-op'd.
 */
export async function hideSplash(win = globalThis) {
  if (hidden) return false;
  const plugin = getSplashPlugin(win);
  if (!plugin || typeof plugin.hide !== "function") return false;
  hidden = true;
  try {
    // A short fade reads as a smooth handoff from splash → app rather than a hard cut.
    await plugin.hide({ fadeOutDuration: 200 });
  } catch {
    // Best-effort: a hide failure must not break boot.
  }
  return true;
}

/**
 * Register the real "web app has painted" signal that triggers the hide. The honest first-paint point
 * is two animation frames after the DOM is ready: the first frame schedules the initial layout/paint,
 * the second runs once that paint has been committed — at which point the app surface is actually
 * visible, so it's safe to lift the splash. We deliberately do NOT use a fixed timer (that risks
 * uncovering a still-blank page or holding the splash too long).
 *
 * Inert off-device: if there's no native splash plugin we never register anything.
 * @param {object} [win=globalThis] injectable for tests.
 */
export function initSplash(win = globalThis) {
  if (!getSplashPlugin(win)) return; // browser/PWA build — nothing to hide.

  const onPainted = () => {
    const raf = win.requestAnimationFrame || ((cb) => win.setTimeout(cb, 16));
    raf(() => raf(() => hideSplash(win)));
  };

  const doc = win.document;
  if (!doc || doc.readyState === "complete" || doc.readyState === "interactive") {
    onPainted();
  } else {
    doc.addEventListener("DOMContentLoaded", onPainted, { once: true });
  }
}

// Auto-init when loaded as a module in the app (harmless no-op off-device). Guarded so importing the
// pure functions in a test (where there's no native splash) doesn't fire anything.
initSplash();
