// TM-1009 — the deploy-time feature switch over the WHOLE verified-phone requirement (client half).
//
// WHY. TM-930/TM-932/TM-982/TM-992 made the stored phone a Firebase-OTP-VERIFIED identity: the
// onboarding gate demands an OTP before it submits, the router retroactively re-gates accounts whose
// stored phone was never verified, and the profile edit blocks saving a changed number until it is
// re-verified. That is the right go-live posture — but it blocks day-to-day testing and onboarding
// (every new/seeded account must complete a real OTP round-trip). This module is the single OFF/ON
// switch: `config.flags.requireVerifiedPhone` ships OFF (testing-friendly) and is flipped ON at
// DEPLOY time (the same sed seam as `flags.membership`, TM-725 — see .github/workflows/deploy.yml),
// never by a source edit.
//
// WHAT OFF MEANS (the committed default). The phone is still COLLECTED and mandatory-present —
// TM-880's needsPhoneNumber gate and the backend's E.164 requirement are untouched — but nothing
// forces it to be VERIFIED:
//   • router.js: the retroactive re-gate term (needsVerifiedPhone → phoneReverifyDecision) is
//     short-circuited out of isOnboarded via effectiveReverifyDecision below, so existing unverified
//     accounts are NOT bounced back through #/onboarding (and the grace nudge banner stays away);
//   • onboarding.js: the gate's phone step just collects the number — the Send-code/OTP controls are
//     not built and the must-verify submit block (phoneVerifyBlocksSubmit below) never fires (the
//     pre-TM-930 behaviour);
//   • profile.js: a CHANGED phone saves without a re-verify (the TM-982 save gate early-returns).
// WHAT ON MEANS: exactly the current (pre-TM-1009) behaviour — every one of those checks runs
// unchanged. The consumers read the flag at their call sites so the pure rules they wrap
// (profile-core.needsVerifiedPhone, phone-reverify-core.phoneReverifyDecision, ...) stay pure and
// keep their own unit tests.
//
// SERVER COORDINATION (TM-986). Real enforcement needs BOTH halves ON: this client flag AND the
// backend `app.phone.require-verified` (PhoneVerificationProperties, also default false, TM-931).
// This module is only the client half; flipping either alone is safe (the client just stops/starts
// asking for the OTP; the server independently accepts/rejects unverified phones).
//
// Framework-free + DOM-free, so it imports cleanly under `node --test` (web/tools/verified-phone-flag.test.mjs).

import { ReverifyDecision } from "./phone-reverify-core.js";

/**
 * The PURE flag read: is the verified-phone requirement ON in this config object? Kept separate from
 * the window-reading {@link verifiedPhoneRequired} so tests (and any off-DOM caller) can evaluate the
 * rule against an explicit config. Same `!!` coercion contract as membershipEnabled()
 * (membership-tier.js): absent config / absent flags block / absent key are all OFF — the safe,
 * committed default — and any truthy injected value counts as ON.
 *
 * @param {object|null|undefined} cfg a `window.TEAMMARHABA_CONFIG`-shaped object.
 * @returns {boolean} true iff `cfg.flags.requireVerifiedPhone` is truthy.
 */
export function requireVerifiedPhoneFlag(cfg) {
  return !!(cfg && cfg.flags && cfg.flags.requireVerifiedPhone);
}

/**
 * True iff the verified-phone requirement is ON for this runtime (`config.flags.requireVerifiedPhone`,
 * shipped OFF in config.js). The single reader every consumer goes through — router.js (the
 * retroactive re-gate term), onboarding.js (the gate's must-verify step), profile.js (the TM-982
 * phone-edit save gate) and phone-reverify-notice.js (the grace nudge) — so the whole requirement
 * flips on ONE config flag, mirroring how membershipEnabled() gates the membership slice. Safe
 * off-DOM (returns false, like the other config readers).
 *
 * @returns {boolean} true iff the flag is ON.
 */
export function verifiedPhoneRequired() {
  return requireVerifiedPhoneFlag(typeof window !== "undefined" ? window.TEAMMARHABA_CONFIG : null);
}

/**
 * Fold the flag into a phone-reverify decision (TM-992): with the requirement OFF, EVERY decision
 * collapses to NONE — no HARD_GATE (so the verified-phone term drops out of router.js's isOnboarded
 * and existing unverified accounts are not re-gated) and no GRACE_NUDGE (so the reverify banner
 * never nags for a requirement that is switched off). With the requirement ON the decision passes
 * through untouched — the current TM-992 grace/force behaviour, unchanged.
 *
 * This is the call-site short-circuit the ticket asks for: phoneReverifyDecision and
 * profile-core.needsVerifiedPhone stay pure and un-flagged; consumers wrap their outcome here.
 *
 * @param {boolean} required the flag ({@link verifiedPhoneRequired}).
 * @param {string} decision a {@link ReverifyDecision} value from phoneReverifyDecision.
 * @returns {string} the decision to act on: `decision` when required, else ReverifyDecision.NONE.
 */
export function effectiveReverifyDecision(required, decision) {
  return required ? decision : ReverifyDecision.NONE;
}

/**
 * The onboarding gate's must-verify submit rule (TM-930), flag-aware: the gate submit is blocked on
 * an unverified phone ONLY while the requirement is ON. OFF ⇒ never blocks — the gate's phone step
 * is collect-only (the pre-TM-930 behaviour): a shape-valid number submits without an OTP and the
 * backend (whose own `app.phone.require-verified` defaults false, TM-931) accepts it.
 *
 * @param {boolean} required the flag ({@link verifiedPhoneRequired}).
 * @param {boolean} phoneVerified onboarding.js's phoneIsVerified() — the composed number has been
 *   OTP-verified + linked this session.
 * @returns {boolean} true when the gate submit must be blocked pending verification.
 */
export function phoneVerifyBlocksSubmit(required, phoneVerified) {
  return required && !phoneVerified;
}
