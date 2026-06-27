// Terms/privacy acceptance gate — the pure decision core (TM-170).
//
// This module holds ONLY the framework-free, side-effect-free logic the gate keys on, so it is
// unit-testable under Node's test runner the same way splash-env.js / biometric-policy.js are
// (the view + router wiring live in terms.js / router.js). The one question it answers:
//
//   needsTermsAcceptance(profile) -> does this signed-in user have to (re-)accept the terms?
//
// The rule (mirrors the backend, which exposes both versions on GET /api/v1/me, TM-170):
//   * currentTermsVersion is the published version the server wants accepted.
//   * termsAcceptedVersion is what the user last accepted (null/absent if never).
//   * The user is gated whenever the accepted version is missing OR differs from the current one —
//     i.e. a brand-new user (never accepted) OR a returning user after a version BUMP.
//
// Fails OPEN (returns false = not gated) when currentTermsVersion is absent/blank: a degraded /me
// that can't tell us the current version must never trap a user behind the gate with no way through
// (same fail-open stance as the onboarding gate in router.js). The backend stays the real authority.

/** Normalise a version-ish value to a trimmed string, or "" for null/undefined/blank. */
function normVersion(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

/**
 * The current published terms version from a MeResponse, or "" if absent/blank.
 * @param {Object|null|undefined} profile a MeResponse (GET /api/v1/me), or null.
 * @returns {string}
 */
export function currentTermsVersion(profile) {
  return normVersion(profile?.currentTermsVersion);
}

/**
 * The version the user last accepted, or "" if never / absent.
 * @param {Object|null|undefined} profile a MeResponse, or null.
 * @returns {string}
 */
export function acceptedTermsVersion(profile) {
  return normVersion(profile?.termsAcceptedVersion);
}

/**
 * Does this user have to accept the terms before using the app?
 *
 * True iff there IS a current version AND the user's accepted version differs from it (never
 * accepted, or accepted an older/different version). Fails open (false) when there's no current
 * version to compare against, so a degraded backend never traps the user.
 *
 * @param {Object|null|undefined} profile a MeResponse (GET /api/v1/me), or null.
 * @returns {boolean} true if the acceptance gate must be shown.
 */
export function needsTermsAcceptance(profile) {
  const current = currentTermsVersion(profile);
  if (current === "") return false; // fail open: nothing to gate against
  return acceptedTermsVersion(profile) !== current;
}
