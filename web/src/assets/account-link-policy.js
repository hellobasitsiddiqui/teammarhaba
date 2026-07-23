// Proof-of-both account-link policy (TM-990, split (b) of TM-306) — the CLIENT-side half of the
// safe multi-provider convergence rule.
//
// Pulled out of auth.js into its own pure module for the same reason as auth-env.js: it is the one
// piece of the linking decision that is unit-testable WITHOUT a browser or the Firebase SDK — feed it
// a description of the signed-in user + the credential outcome, assert the decision. The framework-free
// repo runs these as `node --test web/tools/*.test.mjs` on the PR gate, so the security-critical
// "never auto-link on an unverified match" contract is guarded by a real test. This module has ZERO
// Firebase imports; auth.js keeps the actual `linkWithCredential`/`updatePhoneNumber` SDK calls.
//
// WHY IT MATTERS (the account-takeover hole). The three sign-in paths (email-code, SMS phone, Google)
// each mint a separate Firebase uid unless linked. Converging them onto one account is desirable — but
// converging on a bare identifier match (an email string / phone number that "looks the same") is an
// account-takeover vector: whoever signs a second identity in could be merged into someone else's
// account. The groomed rule (2026-07-22): LINK only with PROOF OF CONTROL OF BOTH identifiers — the
// user verifies the second identifier (an SMS OTP) WHILE SIGNED INTO the first account. That is exactly
// what Firebase's `linkWithCredential` on `auth.currentUser` does: it binds a freshly-verified
// credential to the already-authenticated account, and Firebase itself REFUSES (auth/credential-already-
// in-use) if that identifier already belongs to a DIFFERENT account. So the safe link is: (a) there IS
// a signed-in user, and (b) the credential was just verified in THIS flow. Anything else must NOT link.

/** The Firebase error code raised when the credential already belongs to a different account. */
export const CREDENTIAL_ALREADY_IN_USE = "auth/credential-already-in-use";

/**
 * The three mutually-exclusive outcomes of a link attempt.
 *  - "link": proof of both present → bind the verified credential to the signed-in account.
 *  - "refuse-not-signed-in": no signed-in "first" account to link INTO → this is a fresh sign-in,
 *    not a link; must not fabricate a merge.
 *  - "refuse-unverified": the credential wasn't proven in this flow → refuse (the takeover guard).
 * @typedef {"link"|"refuse-not-signed-in"|"refuse-unverified"} LinkDecision
 */

/**
 * Decide whether a cross-provider link is PROVEN and may proceed.
 *
 * Proof of both = (1) the user is already signed into the first account (`signedInUid` present), AND
 * (2) the second credential was just verified in this flow (`credentialVerifiedInThisFlow` true — e.g.
 * the SMS OTP was entered and `PhoneAuthProvider.credential(verificationId, code)` produced a fresh
 * credential). Both must hold; either alone is refused.
 *
 * This never inspects a raw identifier string to decide a match — matching is Firebase's job, and a
 * collision with another account surfaces at bind time as {@link CREDENTIAL_ALREADY_IN_USE} (see
 * {@link classifyLinkError}), which the caller shows as a hard-block rather than a silent merge.
 *
 * @param {{signedInUid?: string|null, credentialVerifiedInThisFlow?: boolean}} ctx
 * @returns {LinkDecision}
 */
export function decideLink(ctx) {
  const signedInUid = ctx && ctx.signedInUid;
  const verified = !!(ctx && ctx.credentialVerifiedInThisFlow);
  if (!signedInUid) {
    // No first account to link INTO. Binding here would be a sign-in, not a proven link — refuse so a
    // caller can't turn "signed out" into an implicit account merge.
    return "refuse-not-signed-in";
  }
  if (!verified) {
    // The second identifier was not proven in this flow. Linking on an unverified match is THE
    // takeover hole — refuse.
    return "refuse-unverified";
  }
  return "link";
}

/**
 * Convenience predicate: may this link proceed? True only for the fully-proven "link" decision.
 * @param {{signedInUid?: string|null, credentialVerifiedInThisFlow?: boolean}} ctx
 * @returns {boolean}
 */
export function isLinkProven(ctx) {
  return decideLink(ctx) === "link";
}

/**
 * Classify a Firebase error thrown by a link/bind attempt into a stable outcome the UI keys on. The
 * decisive one is {@link CREDENTIAL_ALREADY_IN_USE}: the verified identifier is genuinely owned by
 * ANOTHER account. The safe response is a HARD-BLOCK ("that number/email already belongs to another
 * account — sign in with it instead"), NEVER an automatic merge of the two accounts — merging on a
 * collision is exactly what proof-of-both forbids.
 *
 * @param {{code?: string}} err a Firebase auth error (has a `.code`).
 * @returns {"collision-hard-block"|"other"} `collision-hard-block` for the already-in-use collision.
 */
export function classifyLinkError(err) {
  if (err && err.code === CREDENTIAL_ALREADY_IN_USE) {
    return "collision-hard-block";
  }
  return "other";
}
