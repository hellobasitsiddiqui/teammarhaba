// Biometric policy — the PURE, framework-free decisions behind the TM-282 biometric layer.
//
// Extracted into its own Firebase/SDK-free, DOM-free module for the same reason as auth-env.js
// (TM-230): the parts of biometric security that matter most — "is the feature even usable on this
// device?", "should the app-lock engage right now?", "is the stored setting on?" — are exactly the
// pieces that CANNOT be exercised in CI or a headless browser (there's no fingerprint sensor). So we
// make them pure functions of their inputs and unit-test them with Node's built-in runner
// (`node --test web/tools/*.test.mjs`, the PR gate). The live wiring (biometric.js / biometric-lock.js)
// is a thin shell over these decisions.
//
// Nothing here touches `window`, `navigator`, the Capacitor bridge, or localStorage directly — every
// input is passed in — so the same function answers identically in a test and in the browser.

/**
 * localStorage key for the user's app-lock preference (TM-282). Per-device, not synced to the
 * backend: the app-lock is a local convenience tied to THIS device's enrolled biometrics, so it has
 * no meaning on another device and nothing sensitive is stored (just "on"/"off").
 */
export const APP_LOCK_KEY = "tm-biometric-app-lock";

/**
 * The BiometryErrorType codes (mirrors the plugin enum) we treat as "the user actively dismissed the
 * prompt" rather than "auth genuinely failed". On these we keep the app locked but do NOT show a hard
 * error — the user simply chose not to authenticate yet and can retry.
 */
export const USER_DISMISS_CODES = Object.freeze(["userCancel", "appCancel", "systemCancel"]);

/**
 * Is the biometric feature usable on this device? True only when the device can actually authenticate
 * the user — either real enrolled biometry, OR (when we allow it) a device PIN/pattern/password as the
 * fallback credential. When neither exists we HIDE/disable the feature entirely (an AC): offering an
 * app-lock that can never be unlocked would brick the app.
 *
 * @param {{isAvailable?: boolean, deviceIsSecure?: boolean}} biometry a plugin CheckBiometryResult
 *   (or the subset we need). `isAvailable` = biometry enrolled; `deviceIsSecure` = a PIN/pattern/
 *   password is set.
 * @param {boolean} [allowDeviceCredential=true] whether we permit PIN/passcode as a fallback unlock.
 * @returns {boolean}
 */
export function isBiometricUsable(biometry, allowDeviceCredential = true) {
  if (!biometry || typeof biometry !== "object") return false;
  if (biometry.isAvailable === true) return true;
  // No enrolled biometry, but if the device has a secure lock screen and we allow it, the device
  // credential (PIN/pattern/password) is a valid unlock path.
  return Boolean(allowDeviceCredential) && biometry.deviceIsSecure === true;
}

/**
 * Read the app-lock preference from a storage-like object. Defaults to OFF (an AC: app-lock is opt-in,
 * off by default), and fails safe to OFF on any storage error (private mode, disabled storage) so a
 * storage hiccup can never trap the user behind a lock they didn't enable.
 * @param {{getItem(key: string): (string|null)}} [storage] a localStorage-like object.
 * @returns {boolean}
 */
export function isAppLockEnabled(storage) {
  if (!storage || typeof storage.getItem !== "function") return false;
  try {
    return storage.getItem(APP_LOCK_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Persist the app-lock preference. Returns whether it was stored (false on any storage error, so the
 * caller can surface "couldn't save" without throwing).
 * @param {{setItem(key: string, value: string): void}} storage
 * @param {boolean} enabled
 * @returns {boolean}
 */
export function setAppLockEnabled(storage, enabled) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(APP_LOCK_KEY, enabled ? "true" : "false");
    return true;
  } catch {
    return false;
  }
}

/**
 * Should the app-lock actually engage right now (i.e. show the lock overlay + demand a biometric)?
 * All three must hold: we're inside the native shell (a browser tab has no biometric surface and must
 * be unaffected — an AC), the user has the lock enabled, AND biometry/credential is usable on the
 * device. Any false → the app stays open as normal.
 *
 * @param {{isNative: boolean, lockEnabled: boolean, biometryUsable: boolean}} ctx
 * @returns {boolean}
 */
export function shouldEngageLock({ isNative, lockEnabled, biometryUsable }) {
  return Boolean(isNative) && Boolean(lockEnabled) && Boolean(biometryUsable);
}

/**
 * Classify an authenticate() failure code into how the UI should react.
 *   - "dismissed": the user cancelled — stay locked, no error, allow retry.
 *   - "unavailable": biometry/credential vanished (lockout, not enrolled) — fail OPEN so the user is
 *     never permanently locked out by a sensor problem (the backend is the real security boundary;
 *     this lock is a convenience layer).
 *   - "failed": a genuine non-match — stay locked, allow retry.
 * @param {string} code a BiometryErrorType string.
 * @returns {"dismissed"|"unavailable"|"failed"}
 */
export function classifyAuthError(code) {
  if (USER_DISMISS_CODES.includes(code)) return "dismissed";
  if (
    code === "biometryNotAvailable" ||
    code === "biometryNotEnrolled" ||
    code === "biometryLockout" ||
    code === "noDeviceCredential" ||
    code === "passcodeNotSet"
  ) {
    return "unavailable";
  }
  return "failed";
}
