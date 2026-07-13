// Geolocation helper (TM-280, epic TM-277) — one small, guarded entry point the rest of the web
// layer uses to read the user's current position, so "nearby events / location-relevant content"
// features never have to know whether they're running inside the Capacitor Android shell or a plain
// browser tab.
//
// Two runtimes, one API:
//   • Native (Capacitor Android shell, TM-278): the `@capacitor/geolocation` plugin is injected by
//     the native bridge at runtime as `window.Capacitor.Plugins.Geolocation`. The web app is the
//     LIVE hosted site loaded via `server.url` (no bundler, no `dist/`), so we CANNOT `import` from
//     `@capacitor/core` here — we reach the plugin off the global the bridge installs. Adding the
//     npm dep + `npx cap sync android` (done in CI before assemble) is what wires the native side
//     and auto-merges ACCESS_*_LOCATION into the Android manifest.
//   • Web (any normal browser, and the web Firebase Hosting deploy): the plugin is absent, so we
//     fall back to the standard `navigator.geolocation`. If neither exists the feature simply
//     degrades — callers get a structured "unavailable" result, never an exception.
//
// Permission denial is a first-class, NON-fatal outcome: we resolve a tagged result object rather
// than throwing, so a denied/blocked location prompt degrades the feature (e.g. show all events
// instead of nearby ones) without crashing the page. This mirrors the env-guard style of
// auth-env.js (pure, injectable, no hard dependency on a global being present).
//
// Status values returned by getCurrentPosition():
//   "ok"          → coords present (see `.coords` = { latitude, longitude, accuracy })
//   "denied"      → user/OS refused permission (graceful degrade)
//   "unavailable" → no geolocation API in this runtime, or position couldn't be obtained
//   "timeout"     → a fix wasn't acquired within the timeout
//
// Why a clear rationale: native platforms surface the OS permission dialog the first time a fix is
// requested. We keep `RATIONALE` here as the single user-facing explanation so any UI that wants to
// pre-prompt ("we use your location to show nearby events") shows consistent copy before triggering
// the OS dialog — good practice and required for a non-surprising first-run permission ask.

export const RATIONALE =
  "Circle uses your location to show events and content near you. " +
  "You can decline — the app still works, you'll just see everything instead of what's nearby.";

// Default options for a single fix. High accuracy is off by default (a coarse fix is enough for
// "nearby events" and is faster / less battery); callers can override per-call.
const DEFAULT_OPTIONS = Object.freeze({
  enableHighAccuracy: false,
  timeout: 10000, // ms — bound the wait so a missing/slow fix degrades instead of hanging.
  maximumAge: 60000, // ms — a recent cached fix is fine for nearby-content use.
});

/**
 * The Capacitor Geolocation plugin, if the native bridge has injected it; otherwise null.
 * Reading off the global (not importing) because the web app runs as the hosted site with no
 * bundler — the plugin only exists at runtime inside the native shell.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {object|null}
 */
export function getNativePlugin(win = globalThis) {
  const cap = win && win.Capacitor;
  if (!cap) return null;
  // `isNativePlatform()` guards against the web build of @capacitor/core (which still defines
  // `window.Capacitor` but runs no native plugins). Be defensive: it may be absent on old cores.
  const isNative = typeof cap.isNativePlatform === "function" ? cap.isNativePlatform() : false;
  if (!isNative) return null;
  const plugin = cap.Plugins && cap.Plugins.Geolocation;
  return plugin || null;
}

/**
 * Does THIS runtime have any way to read a position at all (native plugin OR browser API)?
 * Lets callers cheaply decide whether to even show a "find nearby" affordance.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean}
 */
export function isGeolocationSupported(win = globalThis) {
  if (getNativePlugin(win)) return true;
  return Boolean(win && win.navigator && win.navigator.geolocation);
}

// Normalise either source's success payload into one shape. Capacitor and the W3C API both expose
// `position.coords.{latitude,longitude,accuracy}`, so this is mostly a thin, defensive copy.
function toResult(position) {
  const c = (position && position.coords) || {};
  return {
    status: "ok",
    coords: {
      latitude: c.latitude,
      longitude: c.longitude,
      accuracy: c.accuracy,
    },
    timestamp: position && position.timestamp,
  };
}

// Map a thrown/errored geolocation failure to one of our non-fatal statuses. Covers both the
// Capacitor error (a message/string) and the W3C GeolocationPositionError (numeric `.code`:
// 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT).
function classifyError(err) {
  if (err && typeof err.code === "number") {
    if (err.code === 1) return "denied";
    if (err.code === 3) return "timeout";
    return "unavailable";
  }
  const msg = String((err && err.message) || err || "").toLowerCase();
  if (msg.includes("denied") || msg.includes("permission")) return "denied";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  return "unavailable";
}

// Ask for permission on native before requesting a fix, so we control WHEN the OS dialog appears
// (and can pair it with RATIONALE copy in the UI). On web there's no separate permission API to
// call ahead of `getCurrentPosition`, so we skip straight to the fix (the browser prompts inline).
// Returns true if we should proceed to request a position, false if it's already firmly denied.
async function ensureNativePermission(plugin) {
  try {
    if (typeof plugin.checkPermissions === "function") {
      const status = await plugin.checkPermissions();
      const state = status && (status.location || status.coarseLocation);
      if (state === "granted") return true;
      if (state === "denied") {
        // "denied" from checkPermissions on Android can still be re-requestable; ask once.
        if (typeof plugin.requestPermissions === "function") {
          const req = await plugin.requestPermissions();
          const reqState = req && (req.location || req.coarseLocation);
          return reqState === "granted";
        }
        return false;
      }
      // "prompt" / "prompt-with-rationale" → request now.
      if (typeof plugin.requestPermissions === "function") {
        const req = await plugin.requestPermissions();
        const reqState = req && (req.location || req.coarseLocation);
        return reqState === "granted";
      }
    }
  } catch (_err) {
    // If the permission API itself throws, fall through and let getPosition surface the real error.
    return true;
  }
  return true;
}

/**
 * Read the device's current position via the best available source, never throwing.
 *
 * @param {object} [options] per-call overrides merged over DEFAULT_OPTIONS
 *   (enableHighAccuracy, timeout, maximumAge).
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {Promise<{status:string, coords?:object, timestamp?:number, error?:string}>}
 *   status is one of "ok" | "denied" | "unavailable" | "timeout"; on "ok" `coords` is present.
 */
export async function getCurrentPosition(options = {}, win = globalThis) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const native = getNativePlugin(win);

  // --- Native path (Capacitor Android shell) ---
  if (native && typeof native.getCurrentPosition === "function") {
    try {
      const granted = await ensureNativePermission(native);
      if (!granted) return { status: "denied" };
      const position = await native.getCurrentPosition(opts);
      return toResult(position);
    } catch (err) {
      return { status: classifyError(err), error: String((err && err.message) || err || "") };
    }
  }

  // --- Web path (standard browser Geolocation API) ---
  const geo = win && win.navigator && win.navigator.geolocation;
  if (geo && typeof geo.getCurrentPosition === "function") {
    return new Promise((resolve) => {
      geo.getCurrentPosition(
        (position) => resolve(toResult(position)),
        (err) => resolve({ status: classifyError(err), error: String((err && err.message) || "") }),
        opts,
      );
    });
  }

  // --- Neither available: degrade silently ---
  return { status: "unavailable", error: "no geolocation API in this runtime" };
}
