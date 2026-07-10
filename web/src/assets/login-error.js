// Friendly auth-error messaging for the login UI (extracted from login.js in TM-614) — pure, no
// DOM/Firebase/fetch deps, so the whole mapping is unit-testable (login-error.test.mjs).
//
// Two error shapes reach the login screen, and they must be handled differently:
//   • Firebase auth errors carry a machine `.code` (e.g. "auth/wrong-password") AND a raw,
//     developer-facing, Firebase-branded `.message` ("Firebase: Error (auth/…).") that we must
//     never show a user.
//   • The backend's ApiError (api.js) carries NO `.code`, only a `.message` that is already
//     human-friendly and safe to show verbatim.
//
// So: when there's a code, translate it via MESSAGES — and for any code we haven't mapped, fall
// back to a generic message rather than leaking the raw Firebase string (the TM-614 papercut).
// With no code, trust the human `.message` an ApiError already carries.

/** Last-resort message for a coded error we haven't mapped, or an error with no usable message. */
export const GENERIC_ERROR = "Something went wrong — please try again.";

/** Firebase / backend error code -> friendly, human-facing message. */
export const MESSAGES = {
  "auth/invalid-email": "That email address looks invalid.",
  "auth/missing-email": "Please enter your email address.",
  "auth/missing-password": "Please enter a password.",
  "auth/weak-password": "Password is too weak (at least 6 characters).",
  "auth/email-already-in-use": "That email is already registered — try signing in.",
  "auth/user-not-found": "No account for that email — try signing up.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/user-disabled": "This account has been disabled — please contact support.",
  "auth/too-many-requests": "Too many attempts — please try again later.",
  // Common offline / flaky-network failure — previously surfaced the raw Firebase string (TM-614).
  "auth/network-request-failed": "Network error — check your connection and try again.",
  "auth/popup-closed-by-user": "Google sign-in was cancelled.",
  "auth/invalid-phone-number": "That phone number looks invalid — include the country code (e.g. +1…).",
  "auth/invalid-verification-code": "That code is not valid.",
  "auth/code-expired": "That code has expired — request a new one.",
  "auth/operation-not-allowed":
    "This sign-in method isn't enabled for the project (enable it in the Firebase console).",
};

/**
 * Resolve any thrown auth error into a safe, human-facing message for the login screen.
 *
 * @param {{code?: string, message?: string}|null|undefined} err the caught error (or null to clear).
 * @returns {string} a friendly message, or "" when there's nothing to show (falsy err).
 */
export function authErrorMessage(err) {
  if (!err) return "";
  // A machine `.code` means a Firebase (or otherwise coded) error: map it, and for anything we
  // haven't mapped show the generic fallback — never the raw, Firebase-branded `.message`.
  if (err.code) return MESSAGES[err.code] ?? GENERIC_ERROR;
  // No code: an ApiError already carries a human `.message`; trust it, else the generic fallback.
  return err.message ?? GENERIC_ERROR;
}
