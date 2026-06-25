// Biometric confirm hook (TM-282) — a reusable gate for sensitive actions (AC #3).
//
// Call `await confirmSensitiveAction({ reason, title })` right before performing a sensitive
// operation (e.g. an admin role change). It returns a boolean:
//   - On a native device with usable biometry/credential: shows the BiometricPrompt and returns true
//     only on a successful authenticate (fingerprint or device PIN fallback).
//   - On the web build, or a device with no enrolled biometry / no secure lock screen: returns true
//     WITHOUT prompting (it "passes through"). This is deliberate — the biometric layer is an extra
//     local confirmation, not the security boundary; the backend (default-deny, TM-79) still
//     authorises every privileged call. We must never block a legitimate action just because the
//     device has no fingerprint hardware, and the web surface stays unaffected (an AC).
//
// So the contract is: "true = proceed". The caller already has its own styled confirmDialog for
// intent; this adds the identity check on top where the device supports it.

import { isNativeShell, isBiometricAvailable, authenticate } from "./biometric.js";

/**
 * Gate a sensitive action behind a biometric confirm where supported.
 * @param {{reason?: string, title?: string, subtitle?: string}} [opts]
 * @returns {Promise<boolean>} true → proceed with the action.
 */
export async function confirmSensitiveAction(opts = {}) {
  // Not native → no biometric surface; pass through (backend is the real gate).
  if (!isNativeShell()) return true;

  // No usable biometry/credential on this device → pass through rather than block the action.
  const available = await isBiometricAvailable();
  if (!available) return true;

  const res = await authenticate({
    reason: opts.reason ?? "Confirm it's you to continue",
    title: opts.title ?? "Confirm it's you",
    subtitle: opts.subtitle,
    allowDeviceCredential: true,
  });
  return res.ok === true;
}
