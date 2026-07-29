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
  // TM-1149: this is the DEFAULT (no-context) copy — worded so it is CORRECT whether or not a
  // country code was supplied. The old copy ("…include the country code (e.g. +1…)") asserted the
  // country code was missing, which misdiagnosed the common case where the user DID include one
  // (e.g. +44) but got the digit count wrong — it sent them chasing the wrong fix. It also used
  // a US example on a UK-first app. When the caller knows whether a "+"/country code was present it
  // passes context to authErrorMessage() below, which picks the more specific of the two copies.
  "auth/invalid-phone-number": "That phone number looks invalid — check the number and country code (e.g. +44…).",
  "auth/invalid-verification-code": "That code is not valid.",
  "auth/code-expired": "That code has expired — request a new one.",
  "auth/operation-not-allowed":
    "This sign-in method isn't enabled for the project (enable it in the Firebase console).",
};

// TM-1149: the two context-specific copies for a rejected phone number. The renderer picks between
// them from what the user actually typed, so the message never contradicts the input:
//   • a "+"/country code IS present  → the digits are the likely problem, don't tell them to add a
//     country code they already supplied (that was the bug — +44747009007 is a valid +44 prefix but
//     a digit short, and the old copy told the user to add the +44 that was right there);
//   • no "+"/country code at all     → prompt for the country code, which really is missing.
export const INVALID_PHONE_WITH_COUNTRY_CODE =
  "That number doesn't look right — check the digits.";
export const INVALID_PHONE_WITHOUT_COUNTRY_CODE =
  "That phone number looks invalid — include the country code (e.g. +44…).";

/**
 * TM-1149: does this entered phone value already carry a "+"/country code? Pure + trivial so it can
 * be unit-tested and reused by the caller building the {@link authErrorMessage} context. A leading
 * "+" (after trimming) is the E.164 country-code marker the login SMS field expects — its presence
 * means "don't tell the user to add a country code they already supplied". A blank/nullish value is
 * treated as no country code.
 * @param {string|null|undefined} phone the raw value from the phone input.
 * @returns {boolean}
 */
export function hasCountryCode(phone) {
  return typeof phone === "string" && phone.trim().startsWith("+");
}

// TM-1149 (increment): the free, precise "too many digits" pre-validation for the SMS phone path.
// E.164 caps a full international number at 15 DIGITS (country code + national, the leading "+" not
// counted). That single ceiling is universal — no per-country length table — so we can catch an
// obviously-too-long number LOCALLY before spending a Firebase signInWithPhoneNumber round-trip and
// give a precise reason. The complementary per-country "too short" precision needs a length table
// countries.js doesn't have yet and is deliberately deferred to TM-1155 — NOT attempted here.
export const E164_MAX_DIGITS = 15;
export const TOO_MANY_DIGITS_MESSAGE = "That number has too many digits — please check it.";

/**
 * TM-1149: is this entered/composed phone value too long to be a valid E.164 number? Strips every
 * non-digit (so a leading "+", spaces, dashes, parens don't count) and reports whether more than
 * {@link E164_MAX_DIGITS} digits remain. Pure + unit-tested; the SMS send handler calls it before
 * the Firebase call to reject an over-long number for free with {@link TOO_MANY_DIGITS_MESSAGE}.
 * A blank/nullish value is not "too long" (it's empty — a different, later validation concern).
 * @param {string|null|undefined} phone the raw value from the phone input.
 * @returns {boolean}
 */
export function isTooManyDigits(phone) {
  if (typeof phone !== "string") return false;
  const digitCount = (phone.match(/\d/g) ?? []).length;
  return digitCount > E164_MAX_DIGITS;
}

/**
 * TM-1149: the local SMS-send preflight decision — the pure seam that decides whether the send may
 * proceed to Firebase. Returns the {@link Error} the send handler should THROW (rendering its
 * `.message` inline in #sms-error and skipping the Firebase call), or `null` when the number passes
 * every free local check and the handler should proceed to `signInWithPhoneNumber`.
 *
 * <p>Only the free, universal E.164 15-digit "too long" case is enforced here — Firebase itself
 * still validates everything else (empty, malformed, per-country too-short) when we do call it. This
 * is unit-tested so the "reject over-long BEFORE Firebase" contract can't silently regress; the
 * handler in login.js is a thin wrapper that throws whatever this returns.
 * @param {string|null|undefined} phone the raw value from the phone input.
 * @returns {Error|null} the error to throw, or null to proceed to Firebase.
 */
export function smsSendPreflightError(phone) {
  if (isTooManyDigits(phone)) return new Error(TOO_MANY_DIGITS_MESSAGE);
  return null;
}

/**
 * Resolve any thrown auth error into a safe, human-facing message for the login screen.
 *
 * @param {{code?: string, message?: string}|null|undefined} err the caught error (or null to clear).
 * @param {{hasCountryCode?: boolean}} [context] optional caller context. For an
 *   `auth/invalid-phone-number`, `hasCountryCode` says whether the entered value already carried a
 *   "+"/country code (TM-1149) — so the copy points at the digits rather than a country code the
 *   user already supplied. Omit it and the neutral MESSAGES default (correct either way) is used.
 * @returns {string} a friendly message, or "" when there's nothing to show (falsy err).
 */
export function authErrorMessage(err, context) {
  if (!err) return "";
  // A machine `.code` means a Firebase (or otherwise coded) error: map it, and for anything we
  // haven't mapped show the generic fallback — never the raw, Firebase-branded `.message`.
  if (err.code) {
    // TM-1149: for a rejected phone number, when the caller told us whether a country code was
    // present, use the matching context-aware copy instead of the neutral default — so we never
    // tell a user to add a "+44" that's already in the field.
    if (err.code === "auth/invalid-phone-number" && context && typeof context.hasCountryCode === "boolean") {
      return context.hasCountryCode
        ? INVALID_PHONE_WITH_COUNTRY_CODE
        : INVALID_PHONE_WITHOUT_COUNTRY_CODE;
    }
    return MESSAGES[err.code] ?? GENERIC_ERROR;
  }
  // No code: an ApiError already carries a human `.message`; trust it, else the generic fallback.
  return err.message ?? GENERIC_ERROR;
}
