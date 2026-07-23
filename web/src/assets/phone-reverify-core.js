// Retroactive phone re-verification decision — the pure, browser-free core (TM-992).
//
// TM-932 shipped a HARD re-gate: the router folded `needsVerifiedPhone(...)` straight into
// `isOnboarded`, so any existing account whose stored phone was never OTP-verified was bounced through
// the #/onboarding verify gate on its very next entry — no warning, no grace. TM-992 (decision C =
// GRACE, then FORCE, per Basit) softens that: a re-gate-eligible account first gets a DISMISSIBLE
// deadline nudge, and is only HARD-GATED once a CONFIG-DRIVEN deadline has passed.
//
// This module is the single decision seam, split out of the router/notice mounting code for the same
// reason verify-banner-state.js was split out of verify-banner.js: it is the unit-testable core —
// given (needs-reverify?, deadline, now) decide `none` | `grace-nudge` | `hard-gate` — with zero DOM,
// Firebase or fetch dependencies, so `node --test web/tools/*.test.mjs` (the PR gate) guards the whole
// grace→force policy without a browser.
//
// WHY THE INPUT IS A BOOLEAN, NOT `/me`. The "does this account need to re-verify its phone?" question
// already has a shared, tested home: profile-core.needsVerifiedPhone(me, verifiedPhone). Re-deriving it
// here would duplicate (and risk drifting from) that rule. So the router computes needsVerifiedPhone
// once and passes the boolean in — this module owns ONLY the grace/force timing on top of it.

/**
 * The three outcomes of the retroactive re-verify policy. Drives both the router (does it fold the
 * verified-phone term into the onboarding gate?) and the notice module (does it show the nudge?).
 * @readonly
 * @enum {string}
 */
export const ReverifyDecision = Object.freeze({
  NONE: "none", // nothing to do — either verified already, or not eligible for the retroactive re-gate.
  GRACE_NUDGE: "grace-nudge", // eligible, but inside the grace window (or no deadline set) → soft nudge only.
  HARD_GATE: "hard-gate", // eligible AND the deadline has passed → route through the #/onboarding verify gate.
});

/**
 * Parse a configured deadline into an epoch-ms number, or null when it is absent / unparseable.
 *
 * The deadline is a PROD-CONFIG value (`window.TEAMMARHABA_CONFIG.phoneReverifyDeadline`, injected at
 * deploy time like every other config value). We accept either an ISO-8601 string ("2026-09-01" or a
 * full timestamp) or an already-numeric epoch-ms — whatever product finds easiest to set — and treat
 * ANY value we can't turn into a finite instant as "no deadline configured". That conservative parse is
 * load-bearing for the SAFE DEFAULT below: a typo'd deadline must degrade to grace-only, never to an
 * accidental hard-gate on a date we can't actually read.
 *
 * @param {string|number|null|undefined} raw the configured deadline (ISO string, epoch-ms, or absent).
 * @returns {number|null} epoch-ms, or null when absent/unparseable.
 */
export function parseReverifyDeadline(raw) {
  if (raw == null || raw === "") return null;
  // Numeric (or numeric-string) epoch-ms — accept as-is when finite.
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const asNumber = Number(raw);
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(asNumber) && /^\s*\d+\s*$/.test(raw)) {
    return asNumber;
  }
  // Otherwise treat it as a date string (ISO-8601). Date.parse returns NaN for garbage → null.
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide what the retroactive phone re-verify policy should do RIGHT NOW for one account.
 *
 * The whole grace→force rule in one pure function:
 *   • `needsReverify` false → NONE. The account's stored phone is already the Firebase-verified one (or
 *     it isn't eligible for this rule at all — that determination is profile-core.needsVerifiedPhone's
 *     job, computed by the router and passed in). A verified user is NEVER nudged and NEVER re-gated.
 *   • `needsReverify` true, but no deadline configured → GRACE_NUDGE. **THE SAFE DEFAULT** (per the
 *     ticket): until product sets an actual deadline we show the nudge but NEVER hard-gate — we must not
 *     lock existing users out of the app before there is a date to lock them out on.
 *   • `needsReverify` true AND now is BEFORE the deadline → GRACE_NUDGE (inside the grace window).
 *   • `needsReverify` true AND now is AT/AFTER the deadline → HARD_GATE (grace is over → force verify).
 *
 * @param {object} input
 * @param {boolean} input.needsReverify whether the account must re-verify its stored phone — the
 *   profile-core.needsVerifiedPhone(me, currentUser().phoneNumber) outcome, computed by the caller.
 * @param {number|null|undefined} input.deadline the parsed deadline epoch-ms (see
 *   {@link parseReverifyDeadline}), or null/undefined when none is configured.
 * @param {number} input.now the current time in epoch-ms (Date.now()) — injected so the rule is
 *   deterministic and testable.
 * @returns {ReverifyDecision}
 */
export function phoneReverifyDecision({ needsReverify, deadline, now }) {
  // Not eligible / already verified → do nothing.
  if (!needsReverify) return ReverifyDecision.NONE;
  // Eligible but no usable deadline → grace-only forever (the safe default). Never hard-gate here.
  if (deadline == null || !Number.isFinite(deadline)) return ReverifyDecision.GRACE_NUDGE;
  // Eligible with a real deadline: nudge while inside the window, hard-gate once it has passed.
  return now >= deadline ? ReverifyDecision.HARD_GATE : ReverifyDecision.GRACE_NUDGE;
}

/**
 * The grace-nudge copy for the dismissible notice — pure, so the exact wording is unit-testable and the
 * DOM module (phone-reverify-notice.js) stays a thin renderer. When we can name the deadline we give the
 * user the date ("Verify your number by <date>…"); with no configured deadline (the grace-only safe
 * default) we ask them to verify without a date, since there is no cut-off to quote yet.
 *
 * @param {number|null|undefined} deadline the parsed deadline epoch-ms, or null/undefined when unset.
 * @param {(ms:number)=>string} [formatDate] injectable date formatter (defaults to a locale medium date)
 *   — injected so the copy is deterministic under `node --test` (no host-locale drift in assertions).
 * @returns {string} the notice body text.
 */
export function reverifyNoticeText(deadline, formatDate = defaultFormatDate) {
  if (deadline == null || !Number.isFinite(deadline)) {
    return "Please verify your phone number to keep your account secure.";
  }
  return `Please verify your phone number by ${formatDate(deadline)} to keep your account.`;
}

/** Default medium-date formatter (e.g. "1 Sep 2026"). Falls back to an ISO date if Intl is unavailable. */
function defaultFormatDate(ms) {
  try {
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(
      new Date(ms),
    );
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
