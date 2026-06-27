// Email-verification banner — the pure, browser-free half (TM-169).
//
// Split out of verify-banner.js for the same reason push-env.js / splash-env.js were split out of
// their mounting modules: this is the unit-testable core — given the live `/me` account state and a
// resend outcome, decide whether the banner shows and what friendly text to render — with zero DOM,
// Firebase or fetch dependencies, so `node --test web/tools/*.test.mjs` (the PR gate) can guard the
// behaviour without a browser.
//
// CONTRACT. Visibility is driven off the `emailVerified` flag on GET /api/v1/me's `accountState`
// (TM-164), which Firebase owns and the badge work (TM-168) reads from the same place. We treat
// `emailVerified === true` as the ONLY "verified" signal: a missing/null state (Firebase couldn't be
// read in credential-free dev) is NOT proof of verification, but it's also not worth nagging an
// unknown user — so we only show the banner when we positively know the email is unverified.

/**
 * Should the "verify your email" banner be shown for this `/me` response?
 *
 * Only `true` when we positively know the signed-in caller's email is unverified — i.e. Firebase
 * reported `accountState.emailVerified === false`. A verified user, a signed-out caller (`null` me),
 * or an unknown state (`null`/`undefined` emailVerified, e.g. credential-free dev) all suppress it,
 * so the banner never nags someone who is verified and never flickers on a state we couldn't read.
 *
 * @param {?{accountState?: ?{emailVerified?: ?boolean}}} me the GET /me response, or null when signed out.
 * @returns {boolean}
 */
export function shouldShowBanner(me) {
  if (!me) return false;
  return me.accountState?.emailVerified === false;
}

/**
 * The friendly states the Resend control cycles through. Drives both the status line copy and (via
 * verify-banner.js) whether the button is disabled.
 * @readonly
 * @enum {string}
 */
export const ResendState = Object.freeze({
  IDLE: "idle", // before any attempt — the plain "we sent a link to <email>" prompt.
  SENDING: "sending", // request in flight.
  SENT: "sent", // 204 — a fresh verification email is on its way.
  RATE_LIMITED: "rate_limited", // 429 — asked again inside the cooldown.
  ALREADY_VERIFIED: "already_verified", // 422 — Firebase says it's already verified (banner will clear on refresh).
  FAILED: "failed", // anything else (network / 502 upstream / unexpected).
});

/**
 * Map a resend attempt's outcome to the {@link ResendState} the UI should enter.
 *
 * The backend (TM-165) returns 204 on a successful trigger, 422 when the address is already verified,
 * and 429 when asked again inside the per-user cooldown; everything else (network error, 502 upstream
 * Firebase failure) is a generic failure. A 401 never reaches here — api.js redirects to login first.
 *
 * @param {?{status?: number}} error the thrown ApiError (with `.status`), or null/undefined on success.
 * @returns {ResendState}
 */
export function resendOutcome(error) {
  if (!error) return ResendState.SENT;
  switch (error.status) {
    case 422:
      return ResendState.ALREADY_VERIFIED;
    case 429:
      return ResendState.RATE_LIMITED;
    default:
      return ResendState.FAILED;
  }
}

/**
 * The human-facing status line for a given {@link ResendState}. `email` (when known) personalises the
 * idle/sent prompts; everything else is generic. Pure string mapping — no DOM.
 *
 * @param {ResendState} state the current resend state.
 * @param {?string} [email] the caller's email, woven into the idle/sent copy when present.
 * @returns {string}
 */
export function resendMessage(state, email) {
  const who = email ? ` to ${email}` : "";
  switch (state) {
    case ResendState.SENDING:
      return "Sending…";
    case ResendState.SENT:
      return `Verification email sent${who}. Check your inbox (and spam).`;
    case ResendState.RATE_LIMITED:
      return "You just asked for one — please wait a moment before resending.";
    case ResendState.ALREADY_VERIFIED:
      return "Your email is already verified. Refreshing…";
    case ResendState.FAILED:
      return "Could not send the email. Please try again.";
    case ResendState.IDLE:
    default:
      return `Please verify your email${who} to secure your account.`;
  }
}

/**
 * Is the Resend control disabled in this state? Disabled while a request is in flight (SENDING) and
 * once we know the address is already verified (ALREADY_VERIFIED — a refresh is imminent, another
 * resend is pointless). Every other state leaves it clickable (including RATE_LIMITED — the user can
 * try again after the cooldown; the backend re-enforces it).
 *
 * @param {ResendState} state the current resend state.
 * @returns {boolean}
 */
export function isResendDisabled(state) {
  return state === ResendState.SENDING || state === ResendState.ALREADY_VERIFIED;
}
