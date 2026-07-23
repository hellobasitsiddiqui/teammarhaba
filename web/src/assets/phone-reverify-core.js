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

// ---- The grace-banner CTA contract (TM-1005) ----------------------------------------------------
//
// Where "Verify now" on the grace banner actually takes the user. It USED to hash-nav to #/onboarding —
// a dead-end: during the grace window the router still counts the account as onboarded (the verified-
// phone term only folds into the gate on HARD_GATE), so router.js's "onboarded user on #/onboarding"
// guard bounced them straight back home and nothing ever offered a way to verify the UNCHANGED stored
// number. The CTA now lands on the PROFILE (where the phone lives) and announces the intent via a DOM
// CustomEvent; profile.js listens and reveals/focuses its TM-1005 "Verify this number" affordance —
// the same startPhoneVerify → confirmPhoneLink OTP flow, no re-typing of the number required.
//
// Both halves (the notice that dispatches, the profile that listens) import these from HERE so the
// route + event name are one shared, unit-testable contract that cannot drift apart.

/** The hash route the grace banner's "Verify now" CTA navigates to — the profile, where the TM-1005
 *  verify-current-number affordance lives (NOT #/onboarding, which bounces onboarded users). */
export const REVERIFY_CTA_TARGET = "#/profile";

/** The window CustomEvent the CTA dispatches after navigating; profile.js listens for it and reveals +
 *  focuses the "Verify this number" affordance once the phone field has painted. */
export const PHONE_VERIFY_REQUEST_EVENT = "tm:phone-verify-request";

// ---- The cross-account collision recovery affordance (TM-987 / TM-1018) --------------------------
//
// When a re-gate-eligible user tries to verify a number that Firebase already has linked to ANOTHER
// (historical) account, the link fails with auth/credential-already-in-use (or the sibling
// account-exists-with-different-credential). That is a HARD BLOCK with no in-app merge path yet — so a
// user whose number GENUINELY IS theirs (stuck on an old account) must not be left at a dead end.
//
// BOTH verify surfaces can hit this: the onboarding gate (TM-987) AND — for the retroactive cohort
// during the grace window, when the router bounces #/onboarding — the PROFILE phone field (TM-1018).
// The predicate + the exact copy live HERE, in the one pure module both surfaces already share, so the
// affordance can't drift between the two (or silently exist on only one, which was the TM-1018 bug).
// EVENTUAL in-app fix: TM-306(b) claim-transfer ("link with proof of both") would replace this manual
// escape hatch; until then the mailto to support (the TM-987 runbook: Firebase unlink/merge) is it.

/** The support inbox the recovery mailto targets — mirrors help.js's SUPPORT_EMAIL. */
export const PHONE_RECOVERY_SUPPORT_EMAIL = "hello@10xai.co.uk";

/** The prefilled subject line for the recovery mailto (so support can triage the number-stuck case). */
export const PHONE_RECOVERY_SUBJECT = "Phone number stuck on another account";

/** The lead-in copy before the support link ("Is this your number? " + link + suffix). Locked wording. */
export const PHONE_RECOVERY_PROMPT = "Is this your number? ";

/** The support-link text inside the recovery affordance. */
export const PHONE_RECOVERY_LINK_TEXT = "Contact support";

/** The copy after the support link, completing the sentence. */
export const PHONE_RECOVERY_SUFFIX = " to move it to this account.";

/** The ready-built mailto href for the recovery support link (subject URL-encoded). */
export const PHONE_RECOVERY_MAILTO = `mailto:${PHONE_RECOVERY_SUPPORT_EMAIL}?subject=${encodeURIComponent(
  PHONE_RECOVERY_SUBJECT,
)}`;

/**
 * Whether a thrown auth error is the cross-account phone collision hard-block — the ONLY error that
 * should reveal the contact-support recovery affordance. Every other verify error (bad/expired code,
 * rate limit) is retryable on this same account and must NOT surface the support path.
 *
 * @param {{code?: string}|null|undefined} err the caught Firebase auth error.
 * @returns {boolean} true only for auth/credential-already-in-use or account-exists-with-different-credential.
 */
export function isPhoneCollision(err) {
  const code = err?.code;
  return code === "auth/credential-already-in-use" || code === "auth/account-exists-with-different-credential";
}

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
 * THE NUMERIC SANITY FLOOR (TM-1016). The numeric / all-digit-string path is a foot-gun: without a floor
 * it accepts ANY finite number as epoch-MS, so a plausible hand-edit at the deploy-config seam —
 * a bare year ("2026"), a compact date ("20260901"), or an epoch-SECONDS paste ("1788230400") — parses to
 * a tiny millisecond value (~Jan 1970), i.e. a deadline already long past. That would flip an eligible
 * account straight to HARD_GATE, locking out every unverified-phone user — the exact opposite of the
 * "a typo degrades to grace-only, never a hard-gate" invariant this module promises. So we only accept a
 * number (or all-digit string) as epoch-ms when it is a PLAUSIBLE instant: >= EPOCH_MS_FLOOR (1e12, ~Sep
 * 2001). Anything below is not a real millisecond timestamp; we return null → grace-only, never a gate.
 * (ISO-8601 date strings are unaffected — a real date like "2026-09-01" goes through Date.parse below.)
 *
 * @param {string|number|null|undefined} raw the configured deadline (ISO string, epoch-ms, or absent).
 * @returns {number|null} epoch-ms, or null when absent/unparseable/implausible.
 */
// The smallest value we'll trust as an epoch-MILLISECONDS instant: 1e12 ms ≈ 2001-09-09. Below this a
// "number" is far more likely a bare year, a compact YYYYMMDD, or an epoch-SECONDS paste than a real
// millisecond timestamp — none of which we can safely treat as a deadline, so they degrade to grace-only.
const EPOCH_MS_FLOOR = 1e12;

export function parseReverifyDeadline(raw) {
  if (raw == null || raw === "") return null;
  // Numeric epoch-ms — accept only when finite AND a plausible instant (>= the sanity floor). A number
  // below the floor is a mis-entered deadline (bare year / epoch-seconds / YYYYMMDD), not a real ms
  // timestamp; return null so it degrades to grace-only rather than an accidental past-dated hard-gate.
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= EPOCH_MS_FLOOR ? raw : null;
  const asNumber = Number(raw);
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(asNumber) && /^\s*\d+\s*$/.test(raw)) {
    // Same floor for the all-digit string form ("1788230400", "20260901", "2026"): only a value that is
    // itself a plausible epoch-ms instant is a deadline — anything smaller is a typo → grace-only (null).
    return asNumber >= EPOCH_MS_FLOOR ? asNumber : null;
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
