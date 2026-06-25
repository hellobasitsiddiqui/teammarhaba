// Biometric bridge (TM-282) — the thin live layer over the Capacitor biometric plugin.
//
// WHY ACCESS THE PLUGIN VIA window.Capacitor, NOT an import:
// The Android shell (TM-278) loads this web app from the HOSTED origin (capacitor.config.json
// `server.url` → https://teammarhaba.web.app), not from a bundled copy. So the web code can't
// `import "@aparajita/capacitor-biometric-auth"` — that npm module only exists inside the APK's
// Capacitor runtime. Capacitor injects `window.Capacitor` (with `.isNativePlatform()` and
// `.Plugins.<Name>`) into the WebView at load, and that's the contract we read here. In a plain
// browser `window.Capacitor` is undefined, so every call degrades to a safe no-op and the web build
// is completely unaffected (an AC) — same belt-and-braces spirit as auth-env.js (TM-230).
//
// The plugin is @aparajita/capacitor-biometric-auth, registered natively as `BiometricAuthNative`.
// It wraps Android `BiometricPrompt` (AC #1), supports device-credential (PIN/pattern/password)
// fallback via `allowDeviceCredential` (AC #4), and reports enrolment via `checkBiometry()` so we can
// hide/disable the feature when nothing is enrolled (AC #4) — no crash.
//
// The pure decisions (usable? lock engaged? error class?) live in biometric-policy.js and are
// unit-tested; this module only does the live bridge calls + plumbing.

import { isBiometricUsable, classifyAuthError } from "./biometric-policy.js";

const PLUGIN_NAME = "BiometricAuthNative";

/**
 * Is the app running inside the native Capacitor shell (vs a plain browser tab)?
 * @param {object} [win=globalThis]
 * @returns {boolean}
 */
export function isNativeShell(win = globalThis) {
  const cap = win && win.Capacitor;
  return Boolean(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
}

/**
 * The native biometric plugin object, or null if not in the shell / plugin missing.
 * @param {object} [win=globalThis]
 * @returns {object|null}
 */
export function getPlugin(win = globalThis) {
  if (!isNativeShell(win)) return null;
  const plugins = win.Capacitor && win.Capacitor.Plugins;
  const plugin = plugins && plugins[PLUGIN_NAME];
  return plugin || null;
}

/**
 * Inspect device biometry. Always resolves (never throws) so callers can branch simply.
 * In a browser / without the plugin, returns a "nothing available" shape.
 * @param {object} [win=globalThis]
 * @returns {Promise<import("./biometric-policy.js").CheckBiometryResult|object>}
 */
export async function checkBiometry(win = globalThis) {
  const plugin = getPlugin(win);
  if (!plugin || typeof plugin.checkBiometry !== "function") {
    return { isAvailable: false, deviceIsSecure: false, biometryType: 0, reason: "not-native", code: "" };
  }
  try {
    return await plugin.checkBiometry();
  } catch (err) {
    // A failure to even probe biometry is treated as "not available" — never blocks the app.
    return { isAvailable: false, deviceIsSecure: false, biometryType: 0, reason: String(err?.message ?? err), code: "" };
  }
}

/**
 * Is biometric protection offerable on this device right now (real biometry OR an allowed device
 * credential)? Used to hide/disable the settings toggle and the sensitive-action gate when there's
 * nothing to authenticate with (AC #4).
 * @param {object} [win=globalThis]
 * @returns {Promise<boolean>}
 */
export async function isBiometricAvailable(win = globalThis) {
  if (!isNativeShell(win)) return false;
  const biometry = await checkBiometry(win);
  return isBiometricUsable(biometry, true);
}

/**
 * Prompt the user to authenticate. Resolves `{ ok: true }` on success, or
 * `{ ok: false, reason: "dismissed"|"unavailable"|"failed", code }` on failure — it never throws, so
 * call sites stay flat. `allowDeviceCredential` lets the user fall back to their PIN/pattern/password
 * (AC #4), so authentication still works when no biometric is enrolled but the device is secured.
 *
 * @param {{reason?: string, title?: string, subtitle?: string, cancelTitle?: string,
 *          allowDeviceCredential?: boolean}} [opts]
 * @param {object} [win=globalThis]
 * @returns {Promise<{ok: boolean, reason?: string, code?: string}>}
 */
export async function authenticate(opts = {}, win = globalThis) {
  const plugin = getPlugin(win);
  // Not in the shell → there is no biometric surface. "Pass through" so a browser build never blocks
  // a sensitive action behind a prompt it can't show (web is unaffected — AC). The backend remains
  // the real authority on every privileged call.
  if (!plugin || typeof plugin.authenticate !== "function") {
    return { ok: true, reason: "not-native" };
  }
  try {
    await plugin.authenticate({
      reason: opts.reason ?? "Confirm it's you",
      androidTitle: opts.title ?? "Confirm it's you",
      androidSubtitle: opts.subtitle,
      cancelTitle: opts.cancelTitle ?? "Cancel",
      // Fall back to device PIN/pattern/password (AC #4): the user can always get in if the device is
      // secured, even with no fingerprint enrolled.
      allowDeviceCredential: opts.allowDeviceCredential !== false,
    });
    return { ok: true };
  } catch (err) {
    const code = err && typeof err.code === "string" ? err.code : "failed";
    return { ok: false, reason: classifyAuthError(code), code };
  }
}

// Expose a tiny ad-hoc bridge for non-module callers / debugging (mirrors window.tmAuth, window.tmProfile).
if (typeof window !== "undefined") {
  window.tmBiometric = { isNativeShell, isBiometricAvailable, checkBiometry, authenticate };
}
