// Authenticated API client for the (framework-free) web app — TM-108 / 2.2.3.
//
// Every backend call goes through one wrapper so the Firebase ID token rides along as
// `Authorization: Bearer <idToken>` and the backend (default-deny since TM-79) authenticates
// the caller. The token comes from getIdToken() (TM-105); the API base URL comes from
// window.TEAMMARHABA_CONFIG.apiBaseUrl (TM-104). On a 401 the wrapper force-refreshes the
// token and retries once, then sends the user to login.
//
// The token is never logged or persisted here — Firebase owns token storage/rotation, and
// getIdToken() hands us a fresh one per call. We only ever put it on the outbound header.
//
// Consumers:
//   - ES modules:  import { apiFetch, getMe } from "./api.js";
//   - classic <script>: the same helpers are mirrored on `window.tmApi`.

import { getIdToken } from "./auth.js";
import { createSseParser } from "./chat-core.js";
import { shouldAttachToken } from "./api-token-target-core.js";

// Where to send the user when authentication can't be established. The login view is the
// `#/login` hash route owned by the guard/router (TM-109); this is the single seam. Kept as
// a hash route so it needs no server rewrite on the static host.
export const LOGIN_PATH = "#/login";
// Shared with router.js: remembers the protected route to return to after sign-in.
const INTENDED_KEY = "tm.intendedRoute";

/** The configured backend API base URL (TM-104), trailing slashes trimmed. */
function apiBaseUrl() {
  const cfg = (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
  return (cfg.apiBaseUrl || "").replace(/\/+$/, "");
}

/** The app's own origin (for same-origin token scoping, TM-722), or null outside a browser. */
function currentOrigin() {
  return typeof window !== "undefined" && window.location ? window.location.origin : null;
}

/** Resolve a request target: pass an absolute URL through, otherwise prefix the API base. */
function resolveUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Send the user to the login screen, preserving where they were so they can be returned
 * after signing in. No-op outside a browser.
 */
export function redirectToLogin() {
  if (typeof window === "undefined") return;
  // Remember the current route (if it isn't already login) so the guard returns the user
  // there after they sign in — mirrors router.js's deep-link handling.
  const here = window.location.hash;
  if (here && here !== LOGIN_PATH) {
    try {
      window.sessionStorage.setItem(INTENDED_KEY, here);
    } catch {
      /* sessionStorage may be unavailable (private mode) — non-fatal, just skip the return. */
    }
  }
  window.location.hash = LOGIN_PATH;
}

/**
 * Fetch against the backend API with the Firebase ID token attached.
 *
 * Adds `Authorization: Bearer <idToken>` when signed in. If the response is 401, the token
 * is force-refreshed (Firebase may have rotated it) and the request is retried exactly once;
 * a second 401 redirects to login. All other responses (including non-401 errors) are
 * returned to the caller untouched.
 *
 * @param {string} path API path (e.g. "/api/v1/me") or an absolute URL.
 * @param {RequestInit} [options] standard fetch options; any `headers` are preserved.
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, options = {}) {
  const url = resolveUrl(path);
  // Only ever attach the ID token to OUR backend (configured API base or same-origin). An absolute URL
  // to any other origin — or a non-http pseudo-URL — is sent unauthenticated so no bearer token can be
  // exfiltrated off-origin (TM-722 token-target scoping).
  const attachToken = shouldAttachToken(url, apiBaseUrl(), currentOrigin());

  const send = async (forceRefresh) => {
    const headers = new Headers(options.headers || {});
    if (attachToken) {
      const token = await getIdToken(forceRefresh);
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(url, { ...options, headers });
  };

  let response = await send(false);
  if (response.status === 401) {
    // Token likely expired/rotated — get a fresh one and retry once before giving up.
    response = await send(true);
    if (response.status === 401) {
      redirectToLogin();
    }
  }
  return response;
}

/**
 * GET /api/v1/me — the verified caller's identity (TM-107).
 * @returns {Promise<{uid: string, email: ?string, displayName: ?string, role: string}>}
 * @throws {Error} if the response is not ok (a 401 will already have redirected to login).
 */
export async function getMe() {
  const response = await apiFetch("/api/v1/me", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/me failed: ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/v1/me/resend-verification — ask the backend to re-trigger the caller's Firebase
 * email-verification (TM-165). The backend rate-limits per user and refuses (422) if the address is
 * already verified, so the UI can show a precise message. Resolves on success (204); on a non-2xx it
 * throws an {@link ApiError} carrying the HTTP `.status` (422 already-verified, 429 cooldown, else a
 * generic failure) so the verify banner (TM-169) can render the right friendly state. A 401 will have
 * already redirected to login via {@link apiFetch}.
 * @returns {Promise<void>}
 * @throws {ApiError}
 */
export async function resendVerification() {
  const response = await apiFetch("/api/v1/me/resend-verification", {
    method: "POST",
    headers: { Accept: "application/problem+json" },
  });
  if (!response.ok) {
    throw await toApiError(response, "Could not send the verification email. Please try again.");
  }
}

/**
 * GET /api/v1/alerts/active — the site-wide alert-banner read (TM-243). PUBLIC by design: a warning
 * (e.g. a heatwave notice) can show PRE-LOGIN, so this hits the endpoint directly rather than via
 * {@link apiFetch} — whose 401-refresh/redirect must never fire on the anonymous banner poll. The
 * backend decides "active" server-side; this just returns the list.
 *
 * <p>Best-effort by contract: never throws, so the ~5-minute poll in alerts.js can call it in the app
 * shell without a try/catch. A SUCCESSFUL read returns the array (possibly empty — the operator pulled
 * every notice); a FAILURE (non-2xx or network error) returns {@code null}, DISTINCT from an empty
 * array, so the caller can tell "genuinely no alerts" apart from "couldn't reach the server" and keep
 * the last-rendered banners on a transient blip rather than wiping a PERSISTENT CRITICAL notice (TM-734,
 * see alerts-core.adoptActiveResult).
 *
 * @returns {Promise<?Array<{id: number, message: string, level: string, dismissal: string}>>} the active
 *   alerts on success (possibly empty), or {@code null} when the fetch failed.
 */
export async function getActiveAlerts() {
  try {
    const response = await fetch(resolveUrl("/api/v1/alerts/active"), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null; // HTTP error → failure, NOT "no alerts" — keep the last banners.
    const data = await response.json();
    return Array.isArray(data) ? data : []; // a valid but non-array body is a real (empty) success.
  } catch {
    return null; // network/parse error → failure — keep the last banners.
  }
}

/**
 * POST /api/v1/auth/email-code/request — ask the backend to email a one-time login code to `email`
 * (TM-234, the default passwordless front door). UNauthenticated by design (you have no token before
 * you sign in), so it bypasses {@link apiFetch} (whose 401 handling/redirect doesn't apply here).
 * Resolves on success (204). On a 429 the send cooldown is active — surfaced as an {@link ApiError}
 * so the UI can show a "please wait before resending" message; any other non-2xx also throws.
 * @param {string} email the address to send the code to.
 * @returns {Promise<void>}
 * @throws {ApiError}
 */
export async function requestEmailCode(email) {
  const response = await fetch(resolveUrl("/api/v1/auth/email-code/request"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/problem+json" },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) throw await toApiError(response, "Could not send a code. Please try again.");
}

/**
 * POST /api/v1/auth/email-code/verify — submit the 6-digit `code` for `email`; on success the
 * backend returns a Firebase **custom token** (TM-234) the caller exchanges via
 * {@link signInWithEmailCodeToken}. UNauthenticated (same reasoning as {@link requestEmailCode}); a
 * wrong code is a real 401 that must reach the UI (not trigger the api.js redirect), an expired code
 * a 410, and an exhausted/too-fast attempt a 429 — all surfaced as {@link ApiError} with the
 * backend's message so the form can show a precise reason.
 * @param {string} email the address the code was requested for.
 * @param {string} code the 6-digit code the user received.
 * @returns {Promise<string>} the Firebase custom token to sign in with.
 * @throws {ApiError}
 */
export async function verifyEmailCode(email, code) {
  const response = await fetch(resolveUrl("/api/v1/auth/email-code/verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!response.ok) throw await toApiError(response, "That code is not valid.");
  const { customToken } = await response.json();
  return customToken;
}

/** Parse an RFC-7807 problem body into an {@link ApiError}, falling back to {@code fallback}. */
async function toApiError(response, fallback) {
  const problem = await response.json().catch(() => ({}));
  const message = problem.detail || problem.title || fallback;
  return new ApiError(response.status, message);
}

/**
 * Raised by {@link updateMe} when the backend rejects the request. Carries the HTTP status, a
 * human-readable message (from the RFC-7807 `detail`/`title`), and — for a 400 validation failure —
 * the per-field `errors` array the backend sends (`[{ field, message }]`, see GlobalExceptionHandler),
 * so the profile UI can attach messages next to the offending inputs (TM-167).
 */
export class ApiError extends Error {
  constructor(status, message, fieldErrors = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    /** @type {{field: string, message: string}[]} */
    this.fieldErrors = fieldErrors;
  }
}

/**
 * PATCH /api/v1/me — update the signed-in user's own profile fields (TM-162 contract): firstName,
 * lastName, displayName, city, age, phone, notificationPref (EMAIL/PUSH/BOTH), timezone, locale.
 * Send only the fields you want to change. Returns the refreshed {@link MeResponse} on success.
 *
 * On a non-2xx response the body is parsed as RFC-7807 problem JSON and thrown as an {@link ApiError}:
 * a 400 carries the backend's per-field `errors`, so callers can surface them next to inputs (a 401
 * will already have refreshed/redirected via {@link apiFetch}).
 *
 * @param {Object} patch partial profile fields to update.
 * @returns {Promise<Object>} the updated MeResponse.
 * @throws {ApiError}
 */
export async function updateMe(patch) {
  const response = await apiFetch("/api/v1/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    const message = problem.detail || problem.title || `Update failed (${response.status})`;
    throw new ApiError(response.status, message, fieldErrors);
  }
  return response.json();
}

/**
 * GET /api/v1/interests/catalogue — the active interests catalogue for the picker (TM-776). Any
 * signed-in user may read it (the endpoint inherits the default-authenticated chain; it is NOT the
 * admin-only `/api/v1/admin/interests`). Returns the CURRENTLY OFFERED interests only (active + not
 * retired), already ordered highlights/popular first then alphabetically — the same order the client
 * re-derives when grouping. Each row is the lean public shape `{label, category, highlighted,
 * sortWeight}` (no internal id/timestamps). A 401 will already have refreshed/redirected via
 * {@link apiFetch}.
 *
 * @returns {Promise<Array<{label: string, category: string, highlighted: boolean, sortWeight: number}>>}
 * @throws {Error} on a non-2xx response.
 */
export async function getInterestCatalogue() {
  const response = await apiFetch("/api/v1/interests/catalogue", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/interests/catalogue failed: ${response.status}`);
  }
  return response.json();
}

/**
 * GET /api/v1/interests/config — the interests min/max-selection bounds (TM-776). Any signed-in user
 * may read it (default-authenticated chain, NOT the admin-only config endpoint). DB-backed, so it
 * reflects an admin's runtime change. Returns `{ minSelections, maxSelections }` (seeded 1 / 3). A 401
 * will already have refreshed/redirected via {@link apiFetch}.
 *
 * @returns {Promise<{minSelections: number, maxSelections: number}>}
 * @throws {Error} on a non-2xx response.
 */
export async function getInterestConfig() {
  const response = await apiFetch("/api/v1/interests/config", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/interests/config failed: ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/v1/me/onboarding — complete the first-login profile gate (TM-250) in one atomic call:
 * the three required minimum fields (name, location, age) are persisted AND onboarding is marked
 * complete server-side. Unlike {@link updateMe} (partial PATCH), all three are required: the backend
 * rejects a missing/blank field or an out-of-range age with a 400 carrying per-field `errors`, which
 * the gate UI attaches next to the offending inputs. Returns the updated {@link MeResponse} (now
 * `onboardingCompleted: true`) so the caller can drop the gate and proceed.
 *
 * @param {{name: string, location: string, age: number}} body the three required fields.
 * @returns {Promise<Object>} the updated MeResponse.
 * @throws {ApiError}
 */
export async function submitOnboarding(body) {
  const response = await apiFetch("/api/v1/me/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    const message = problem.detail || problem.title || `Onboarding failed (${response.status})`;
    throw new ApiError(response.status, message, fieldErrors);
  }
  return response.json();
}

/**
 * POST /api/v1/me/onboarding-complete — mark first-run onboarding finished for the caller (TM-163
 * endpoint; wired to the first-login tour in TM-171). Idempotent server-side: completing an already-
 * complete account is a no-op. Used by the product tour to durably suppress the auto first-run tour
 * across devices/sessions once the user has finished or skipped it (localStorage alone is per-device
 * and resets when storage is cleared). Returns the updated {@link MeResponse} (now
 * `onboardingCompleted: true`); throws with the HTTP status on any non-2xx (a 401 will already have
 * refreshed/redirected via {@link apiFetch}).
 *
 * @returns {Promise<Object>} the updated MeResponse.
 */
export async function completeOnboarding() {
  const response = await apiFetch("/api/v1/me/onboarding-complete", {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`POST /api/v1/me/onboarding-complete failed: ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/v1/me/accept-terms — record the caller's acceptance of a terms/privacy `version`
 * (TM-170 client → TM-163 endpoint). The server stamps the acceptance time and returns the updated
 * {@link MeResponse}, now carrying `termsAcceptedVersion === version`, so the caller can drop the
 * acceptance gate and proceed. Identity comes from the Bearer token, never the body.
 *
 * @param {string} version the terms version being accepted (e.g. the `currentTermsVersion` from /me).
 * @returns {Promise<Object>} the updated MeResponse.
 * @throws {ApiError} on a non-2xx response (a 401 will already have refreshed/redirected via apiFetch).
 */
export async function acceptTerms(version) {
  const response = await apiFetch("/api/v1/me/accept-terms", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ version }),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    const message = problem.detail || problem.title || `Accept terms failed (${response.status})`;
    throw new ApiError(response.status, message, fieldErrors);
  }
  return response.json();
}

/**
 * GET /api/v1/me/membership — the caller's membership (TM-474). The account is enrolled just-in-time
 * onto the default `PAY_PER_EVENT` tier on first read, so this always resolves for an authenticated
 * caller. Returns `{ tier, firstEventCreditAvailable }`: `tier` is one of
 * `PAY_PER_EVENT | MONTHLY | DIAMOND`, and `firstEventCreditAvailable` is whether the account's
 * first-event freebie is still available. Identity comes from the Bearer token, never the body.
 *
 * @returns {Promise<{tier: string, firstEventCreditAvailable: boolean}>} the caller's membership.
 * @throws {Error} on a non-2xx response (a 401 will already have refreshed/redirected via apiFetch).
 */
export async function getMembership() {
  const response = await apiFetch("/api/v1/me/membership", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/me/membership failed: ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/v1/me/membership/tier — self-switch the caller's membership `tier` (TM-474). PAYMENT-GATED
 * since TM-620: switching into a paid tier (MONTHLY/DIAMOND) requires an active subscription for that
 * tier — without one the server answers 402 ("Subscription required") and the client should send the
 * user to the Subscribe checkout instead; leaving a paid tier while the subscription still renews is a
 * 409 pointing at cancel. Idempotent server-side: switching to the tier already held returns the
 * unchanged membership. Returns the resulting `{ tier, firstEventCreditAvailable }`; a bad/unknown tier
 * is a 400 carrying per-field `errors`. Identity comes from the Bearer token, never the body.
 *
 * @param {"PAY_PER_EVENT"|"MONTHLY"|"DIAMOND"} tier the tier to switch to.
 * @returns {Promise<{tier: string, firstEventCreditAvailable: boolean}>} the resulting membership.
 * @throws {ApiError} on a non-2xx response (a 401 will already have refreshed/redirected via apiFetch).
 */
export async function switchTier(tier) {
  const response = await apiFetch("/api/v1/me/membership/tier", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ tier }),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    const message = problem.detail || problem.title || `Switch tier failed (${response.status})`;
    throw new ApiError(response.status, message, fieldErrors);
  }
  return response.json();
}

/**
 * GET /api/v1/me/subscription — the caller's recurring subscription state (TM-620). Always a 200: a
 * caller who never subscribed gets the well-defined none-state `{ subscribed: false }` (everything else
 * null), so the manage-subscription screen renders off one shape. When subscribed, returns
 * `{ subscribed, tier, status, currentPeriodStart, currentPeriodEnd, renewing, amountPence }` where
 * `status` is `ACTIVE | PAST_DUE | CANCELED` and `renewing` says whether renewals still run
 * ("Renews on …" vs "Ends on …" copy).
 *
 * @returns {Promise<{subscribed: boolean, tier?: string, status?: string, currentPeriodStart?: string,
 *   currentPeriodEnd?: string, renewing?: boolean, amountPence?: number}>}
 * @throws {ApiError}
 */
export async function getSubscription() {
  const response = await apiFetch("/api/v1/me/subscription", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, `Could not load your subscription (${response.status}).`);
  return response.json();
}

/**
 * POST /api/v1/me/subscription/checkout — open the Subscribe checkout for a paid tier (TM-620): the
 * first monthly charge (£9.99 MONTHLY / £19.99 DIAMOND) plus the card save for off-session renewals.
 * Returns `{ tier, amountPence, paymentToken, provider }`; the client mounts the Revolut card widget
 * with the single-use `paymentToken` and `savePaymentMethodFor: "merchant"`. The subscription itself is
 * activated server-side by the verified payment webhook — never by the client claiming success. A 409
 * means an active subscription already exists; a 400 means the free base tier was requested. The price
 * is resolved server-side from the locked table — `amountPence` here is display-only.
 *
 * @param {"MONTHLY"|"DIAMOND"} tier the paid tier to subscribe to.
 * @returns {Promise<{tier: string, amountPence: number, paymentToken: string, provider: string}>}
 * @throws {ApiError}
 */
export async function subscriptionCheckout(tier) {
  const response = await apiFetch("/api/v1/me/subscription/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ tier }),
  });
  if (!response.ok) throw await toApiError(response, "Could not start the subscription checkout.");
  return response.json();
}

/**
 * POST /api/v1/me/subscription/cancel — stop renewals (TM-620). The paid tier survives until the end
 * of the already-paid period (`currentPeriodEnd`), then the account downgrades to pay-per-event
 * server-side. Idempotent: cancelling an already-cancelled subscription returns it unchanged. A 404
 * means there is no subscription to cancel. Returns the updated subscription state (same shape as
 * {@link getSubscription}).
 *
 * @returns {Promise<{subscribed: boolean, tier?: string, status?: string, currentPeriodEnd?: string,
 *   renewing?: boolean}>}
 * @throws {ApiError}
 */
export async function cancelSubscription() {
  const response = await apiFetch("/api/v1/me/subscription/cancel", {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, "Could not cancel your subscription.");
  return response.json();
}

/**
 * GET /api/v1/admin/users/{id}/subscription — ADMIN read of one account's subscription state + billing
 * history (TM-620), the data behind the admin users console's subscription panel. Returns
 * `{ subscription, charges }`: `subscription` is the same shape as {@link getSubscription} (the
 * none-state when the account never subscribed) and `charges` is the charge-attempt ledger newest-first
 * (`{ id, kind, status, tier, amountPence, provider, providerOrderId, periodStart, periodEnd,
 * createdAt }`). A non-admin gets a 403.
 *
 * @param {number|string} userId the account id.
 * @returns {Promise<{subscription: object, charges: Array<object>}>}
 * @throws {ApiError}
 */
export async function adminGetUserSubscription(userId) {
  const response = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(userId)}/subscription`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, `Could not load the subscription (${response.status}).`);
  return response.json();
}

/**
 * GET /api/v1/me/orders — the caller's checkout orders newest-first (TM-481), the data behind the
 * "my tickets / purchases" screen. Read-only: it lists the orders checkout (TM-477) already recorded for
 * the signed-in caller. Each order is `{ id, eventId, amountPence, status, createdAt }` where `status` is
 * one of `PENDING | CONFIRMED | CANCELLED | REFUND_DUE | REFUNDED` and `createdAt` is an ISO-8601 instant. A caller
 * who has never checked anything out gets an empty array (never a 404). Identity comes from the Bearer
 * token, never the client.
 *
 * @returns {Promise<Array<{id: number, eventId: number, amountPence: number, status: string, createdAt: string}>>}
 *   the caller's orders newest-first (possibly empty).
 * @throws {Error} on a non-2xx response (a 401 will already have refreshed/redirected via apiFetch).
 */
export async function getMyOrders() {
  const response = await apiFetch("/api/v1/me/orders", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/me/orders failed: ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/v1/events/{id}/checkout — RSVP checkout for an event (TM-477/TM-478). Resolves the caller's
 * entitlement server-side and records an order; the response tells the checkout screen what to do next:
 *   • FREE / INCLUDED → `{ paymentRequired: false, order: {status:"CONFIRMED"…}, rsvp: {state…} }` — the
 *     RSVP is already confirmed, nothing more to do.
 *   • PAY → `{ paymentRequired: true, order: {status:"PENDING"…}, paymentToken: "<revolut order token>" }`
 *     — mount the Revolut widget with `paymentToken`; the RSVP is held back until the payment settles
 *     (a webhook confirms it server-side). `paymentToken` is single-use and only present on a FRESH PAY.
 * Idempotent per (user, event): a repeat returns the same order. Identity comes from the Bearer token,
 * never the body. An UPGRADE-required tier is a 403; a hidden/missing event is a 404.
 *
 * @param {number|string} eventId the event to check out.
 * @returns {Promise<{order: object, paymentRequired: boolean, rsvp?: object, paymentToken?: string}>}
 * @throws {ApiError} on a non-2xx response, carrying `.status` + the backend's reason (a 401 will already
 *   have refreshed/redirected via apiFetch).
 */
export async function checkout(eventId) {
  const response = await apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/checkout`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await toApiError(response, `Checkout failed (${response.status}). Please try again.`);
  }
  return response.json();
}

/**
 * POST /api/v1/me/devices — register (idempotent upsert) one of the caller's push devices by its
 * FCM/APNs registration `token` and `platform` (TM-279 client → TM-283 endpoint), so the send-push
 * service (TM-284) can target it. Identity comes from the Bearer token, never the body. Re-sending
 * the same token re-points it at the caller and refreshes its platform/timestamp (no duplicate).
 *
 * @param {string} token the opaque push registration token.
 * @param {"ANDROID"|"IOS"|"WEB"} platform the device platform.
 * @returns {Promise<{token: string, platform: string, updatedAt: string}>} the stored registration.
 * @throws {Error} on a non-2xx response (a 401 will already have refreshed/redirected via apiFetch).
 */
export async function registerDevice(token, platform) {
  const response = await apiFetch("/api/v1/me/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token, platform }),
  });
  if (!response.ok) {
    throw new Error(`POST /api/v1/me/devices failed: ${response.status}`);
  }
  return response.json();
}

/**
 * DELETE /api/v1/me/devices/{token} — deregister a device push token on sign-out / invalidation
 * (TM-279 → TM-283). Idempotent: removing an unknown/already-removed token is still success (204),
 * so a retried sign-out never errors. The token rides in the path (FCM tokens are URL-safe, but we
 * encode defensively). Resolves on success; throws on any other non-2xx.
 *
 * @param {string} token the push registration token to remove.
 * @returns {Promise<void>}
 */
export async function deregisterDevice(token) {
  const response = await apiFetch(`/api/v1/me/devices/${encodeURIComponent(token)}`, {
    method: "DELETE",
    headers: { Accept: "application/problem+json" },
  });
  if (!response.ok) {
    throw new Error(`DELETE /api/v1/me/devices/{token} failed: ${response.status}`);
  }
}

/**
 * GET /api/v1/me/notifications/badge — the caller's notification bell counts (TM-454): `unseen` (the
 * bell BADGE — what opening the bell clears) and `unread` (per-item, survives a mark-seen). The header
 * bell (TM-455) shows the `unseen` count, summed with chat-unread once that sibling lands. A 401 will
 * already have refreshed/redirected via {@link apiFetch}.
 * @returns {Promise<{unseen: number, unread: number}>}
 * @throws {Error} on a non-2xx response.
 */
export async function getNotificationBadge() {
  const response = await apiFetch("/api/v1/me/notifications/badge", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/me/notifications/badge failed: ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/v1/me/notifications/seen — opening the bell: mark all of the caller's unseen
 * notifications seen (clears the badge). Idempotent; returns the refreshed (now zero-unseen) counts
 * so the caller can repaint the bell straight from the response with no follow-up GET (TM-454 /
 * TM-455). A 401 will already have refreshed/redirected via {@link apiFetch}.
 * @returns {Promise<{unseen: number, unread: number}>}
 * @throws {Error} on a non-2xx response.
 */
export async function markNotificationsSeen() {
  const response = await apiFetch("/api/v1/me/notifications/seen", {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`POST /api/v1/me/notifications/seen failed: ${response.status}`);
  }
  return response.json();
}

/**
 * GET /api/v1/me/notifications — the caller's notification feed, newest-first, in the shared page
 * envelope `{ items, page, size, totalElements, totalPages }` (TM-454). Each item is a
 * NotificationResponse (`{ id, type, title, body, deepLink, sourceRef, sticky, createdAt, seenAt,
 * readAt, seen, read }`). Read by the bell-opened panel (TM-456), which classifies items into chat
 * groups vs ungrouped admin/system rows. Only `page`/`size` are tunable (the order is server-fixed).
 * A 401 will already have refreshed/redirected via {@link apiFetch}.
 * @param {{page?: number, size?: number}} [opts]
 * @returns {Promise<{items: Object[], page: number, size: number, totalElements: number, totalPages: number}>}
 * @throws {Error} on a non-2xx response.
 */
export async function listNotifications({ page, size } = {}) {
  const params = new URLSearchParams();
  if (page != null) params.set("page", String(page));
  if (size != null) params.set("size", String(size));
  const query = params.toString();
  const response = await apiFetch(`/api/v1/me/notifications${query ? `?${query}` : ""}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/me/notifications failed: ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/v1/me/notifications/{id}/read — tapping a notification: one-way mark it read (TM-454).
 * Idempotent; returns the updated NotificationResponse. A foreign/unknown id is a 404. The panel
 * (TM-456) fires this on a row/chat-group tap so the item (or the group's messages) clears. A 401 will
 * already have refreshed/redirected via {@link apiFetch}.
 * @param {number|string} id the notification's id.
 * @returns {Promise<Object>} the updated NotificationResponse.
 * @throws {Error} on a non-2xx response.
 */
export async function markNotificationRead(id) {
  const response = await apiFetch(`/api/v1/me/notifications/${encodeURIComponent(id)}/read`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`POST /api/v1/me/notifications/${id}/read failed: ${response.status}`);
  }
  return response.json();
}

/* ─────────────────────────────── Conversations (chat) — read API, F2 / TM-436 ──────────────────
 * The Chat section reads three endpoints: the caller's conversation list, one thread's messages, and
 * a mark-read POST fired when a thread is opened (all TM-438). All the GETs use the shared page
 * envelope `{ items, page, size, totalElements, totalPages }` (zero-based `page`), the exact same
 * shape the notifications + events feeds use, so the view consumes `data.items` uniformly.
 * Writing is now live too: {@link postConversationMessage} (TM-448) sends to the member-gated POST
 * endpoint (TM-447), which is stricter than reading — it 403s a non-member / muted / removed caller
 * and 409s a closed thread, so the composer can lock itself with a clear reason (see chat-core.js
 * `classifyPostError`).
 * ---------------------------------------------------------------------------------------------- */

/**
 * GET /api/v1/me/conversations — the caller's conversations (event group chats + admin broadcasts),
 * newest-activity first, in the shared page envelope. Each item is a ConversationSummaryResponse
 * (`{ id, type: "EVENT_GROUP"|"ADMIN_BROADCAST", title, eventId, lastMessagePreview, lastMessageAt,
 * lastActiveAt, unreadCount }`). The unified chat LIST (TM-438) renders these with a per-type badge;
 * a 401 will already have refreshed/redirected via {@link apiFetch}.
 * @param {{page?: number, size?: number}} [opts]
 * @returns {Promise<{items: Object[], page: number, size: number, totalElements: number, totalPages: number}>}
 * @throws {Error} on a non-2xx response.
 */
export async function listMyConversations({ page, size } = {}) {
  const params = new URLSearchParams();
  if (page != null) params.set("page", String(page));
  if (size != null) params.set("size", String(size));
  const query = params.toString();
  const response = await apiFetch(`/api/v1/me/conversations${query ? `?${query}` : ""}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/me/conversations failed: ${response.status}`);
  }
  return response.json();
}

/**
 * GET /api/v1/me/conversations/unread-total — the caller's aggregate unread across ALL their threads
 * (TM-582), as `{ total: number }`. The Chat-tab badge (TM-439) reads this single server-authoritative
 * number instead of summing the paged list's per-thread `unreadCount` (which only ever saw the first
 * page and undercounted a caller with more than one page of threads). A 401 will already have
 * refreshed/redirected via {@link apiFetch}.
 * @returns {Promise<{total: number}>}
 * @throws {Error} on a non-2xx response.
 */
export async function getConversationsUnreadTotal() {
  const response = await apiFetch("/api/v1/me/conversations/unread-total", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/me/conversations/unread-total failed: ${response.status}`);
  }
  return response.json();
}

/**
 * GET /api/v1/conversations/{id}/messages — one thread's messages, in the shared page envelope. Each
 * item is a ConversationMessageResponse (`{ id, senderId, body, deepLink, system, reactions[],
 * createdAt }`). Read by the thread view (TM-438); a 401 will already have refreshed/redirected via
 * {@link apiFetch}.
 * @param {number|string} id the conversation id.
 * @param {{page?: number, size?: number}} [opts]
 * @returns {Promise<{items: Object[], page: number, size: number, totalElements: number, totalPages: number}>}
 * @throws {Error} on a non-2xx response.
 */
export async function getConversationMessages(id, { page, size } = {}) {
  const params = new URLSearchParams();
  if (page != null) params.set("page", String(page));
  if (size != null) params.set("size", String(size));
  const query = params.toString();
  const response = await apiFetch(
    `/api/v1/conversations/${encodeURIComponent(id)}/messages${query ? `?${query}` : ""}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`GET /api/v1/conversations/${id}/messages failed: ${response.status}`);
  }
  return response.json();
}

/**
 * GET /api/v1/conversations/{id}/members — the thread's mentionable roster (TM-469): its active members
 * EXCEPT the caller, each a ConversationMemberResponse (`{ userId, displayName, role }`). Members-only
 * (a 403 for a non-member, already surfaced by {@link apiFetch}). Read by the chat thread view to feed
 * the composer's @mention autocomplete and to highlight mentions in rendered messages. Best-effort at
 * the call site — a failure just means the autocomplete/highlight degrade, never that the thread breaks.
 * @param {number|string} id the conversation id.
 * @returns {Promise<{userId:number, displayName:string, role:string}[]>}
 * @throws {Error} on a non-2xx response.
 */
export async function getConversationMembers(id) {
  const response = await apiFetch(`/api/v1/conversations/${encodeURIComponent(id)}/members`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/conversations/${id}/members failed: ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/v1/conversations/{id}/read — opening a thread marks it read (clears its unread count).
 * Idempotent; returns a MarkReadResponse (`{ conversationId, lastReadAt, unreadCount }`). The thread
 * view (TM-438) fires this on open, fire-and-forget. A 401 will already have refreshed/redirected via
 * {@link apiFetch}.
 * @param {number|string} id the conversation id.
 * @returns {Promise<Object>} the MarkReadResponse.
 * @throws {Error} on a non-2xx response.
 */
export async function markConversationRead(id) {
  const response = await apiFetch(`/api/v1/conversations/${encodeURIComponent(id)}/read`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`POST /api/v1/conversations/${id}/read failed: ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/v1/conversations/{id}/messages — post a message to a conversation thread (TM-448 wiring the
 * TM-447 endpoint). `body` is the message text (the backend bounds it non-blank, ≤500; the composer
 * validates the same rule client-side first). Returns the created ConversationMessageResponse (201) so
 * the caller can echo the confirmed message (with its real id / server `createdAt`) in place of the
 * optimistic bubble.
 *
 * <p>Unlike the read endpoints (which throw a bare Error), this throws an {@link ApiError} carrying the
 * HTTP `.status` and the backend's problem `detail`, because the composer must DISTINGUISH outcomes:
 *   • 403 — not a member / muted (READ_ONLY) / removed  → a permanent block: lock the composer
 *   • 409 — the thread is closed / read-only            → a permanent block: lock the composer
 *   • 404 — the conversation no longer exists           → a permanent block: lock the composer
 *   • 400 — body failed validation (blank / >500)       → surface inline, keep composing
 *   • 5xx / network                                     → transient: keep the draft, offer a retry
 * The mapping itself is the pure, unit-tested `classifyPostError` in chat-core.js. A 401 will already
 * have refreshed/redirected via {@link apiFetch}.
 * <p>An optional {@code replyToMessageId} (TM-466) posts this as a REPLY quoting an earlier message in
 * the same thread; the backend validates it names a live, same-thread message (a foreign / removed
 * target is a {@code 400}). Omitted / nullish → a plain message. The created response then carries the
 * quoted-parent snippet in {@code replyTo} so the confirmed echo renders the quote.
 * @param {number|string} id the conversation id.
 * @param {string} body the message text (≤500 chars, non-blank).
 * @param {{replyToMessageId?: (number|string|null)}} [opts] optional reply target (TM-466).
 * @returns {Promise<Object>} the created ConversationMessageResponse.
 * @throws {ApiError} on a non-2xx response, carrying `.status` + the backend's reason.
 */
export async function postConversationMessage(id, body, { replyToMessageId = null } = {}) {
  const payload = { body };
  // Only include the reply target when it's a real, positive id — keep a plain post's body minimal
  // (and never send a null the backend's @Positive would trip on).
  const replyId = Number(replyToMessageId);
  if (Number.isFinite(replyId) && replyId > 0) payload.replyToMessageId = replyId;
  const response = await apiFetch(`/api/v1/conversations/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await toApiError(response, `Could not send your message (${response.status}). Please try again.`);
  }
  return response.json();
}

/**
 * POST /api/v1/conversations/{id}/announcements — post an admin/host ANNOUNCEMENT to an event's group
 * chat (TM-710). Gated server-side to {@code ROLE_ADMIN} (a non-admin is a 403 whatever the UI shows),
 * and unlike {@link postConversationMessage} it is NOT member-gated — an admin may announce in any event
 * chat, even one they don't attend. `body` is the announcement text (backend bounds it non-blank, ≤500;
 * the composer validates the same rule first). Returns the created ConversationMessageResponse (201),
 * carrying {@code kind: "ANNOUNCEMENT"} so the caller can echo it as an announcement.
 *
 * <p>Throws an {@link ApiError} carrying the HTTP `.status` + the backend's `detail`, so the composer
 * can distinguish outcomes exactly like the ordinary post (403 admin gate, 409 closed thread, 404 gone,
 * 400 validation), reusing the same {@code classifyPostError} mapping.
 * @param {number|string} id the conversation id.
 * @param {string} body the announcement text (≤500 chars, non-blank).
 * @returns {Promise<Object>} the created ConversationMessageResponse (kind ANNOUNCEMENT).
 * @throws {ApiError} on a non-2xx response, carrying `.status` + the backend's reason.
 */
export async function postConversationAnnouncement(id, body) {
  const response = await apiFetch(`/api/v1/conversations/${encodeURIComponent(id)}/announcements`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw await toApiError(response, `Could not send your announcement (${response.status}). Please try again.`);
  }
  return response.json();
}

/**
 * PATCH /api/v1/conversations/{id}/messages/{messageId} — edit the caller's OWN message (TM-467). `body`
 * is the replacement text (backend bounds it non-blank, ≤500; the inline editor validates the same rule
 * first). Returns the edited ConversationMessageResponse (200) — carrying the new body + a set `editedAt`
 * — so the caller can reconcile its optimistic edit.
 *
 * <p>Throws an {@link ApiError} carrying the HTTP `.status` + the backend's problem `detail`, because the
 * inline editor must distinguish outcomes: a 403 (not your message), a 409 (thread closed OR the
 * ~5-minute edit window has passed — the message is locked), a 404 (message gone), a 400 (blank / >500).
 * A 401 will already have refreshed/redirected via {@link apiFetch}.
 * @param {number|string} id the conversation id.
 * @param {number|string} messageId the message to edit (must be the caller's own).
 * @param {string} body the replacement text (≤500 chars, non-blank).
 * @returns {Promise<Object>} the edited ConversationMessageResponse.
 * @throws {ApiError} on a non-2xx response, carrying `.status` + the backend's reason.
 */
export async function editConversationMessage(id, messageId, body) {
  const response = await apiFetch(
    `/api/v1/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  if (!response.ok) {
    throw await toApiError(response, `Couldn't edit your message (${response.status}). Please try again.`);
  }
  return response.json();
}

/**
 * DELETE /api/v1/conversations/{id}/messages/{messageId} — delete the caller's OWN message (TM-467). A
 * soft-delete: the message drops out of the timeline (like an admin moderation removal). Owner-scoped and
 * allowed anytime. Returns a thin RemovedMessageResponse (`{ messageId, conversationId, removed,
 * removedAt }`).
 *
 * <p>Throws an {@link ApiError} carrying `.status` + the backend's problem `detail` (a 403 if it isn't the
 * caller's message, a 404 if it's already gone), so the caller can surface an honest reason and roll its
 * optimistic removal back. A 401 will already have refreshed/redirected via {@link apiFetch}.
 * @param {number|string} id the conversation id.
 * @param {number|string} messageId the message to delete (must be the caller's own).
 * @returns {Promise<Object>} the RemovedMessageResponse.
 * @throws {ApiError} on a non-2xx response, carrying `.status` + the backend's reason.
 */
export async function deleteConversationMessage(id, messageId) {
  const response = await apiFetch(
    `/api/v1/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw await toApiError(response, `Couldn't delete your message (${response.status}). Please try again.`);
  }
  return response.json();
}

/**
 * POST /api/v1/conversations/{id}/typing — signal that the caller is (or, with {@code typing:false}, has
 * stopped) typing in a thread (TM-465). The server fans a transient {@code typing} SSE event out to the
 * thread's OTHER connected members; nothing is persisted.
 *
 * <p><b>Best-effort, never throws.</b> A typing hint is pure sugar over the real chat, so a failed signal
 * must never surface an error or break composing — this swallows any failure (returning {@code false})
 * exactly like {@link openConversationStream} swallows a dropped socket. Callers DEBOUNCE it client-side
 * (chat-core {@code shouldSignalTyping}) so it's at most one call every few seconds, never per-keystroke.
 *
 * @param {number|string} id the conversation id.
 * @param {boolean} [typing=true] {@code true} = started/continuing; {@code false} = explicitly stopped.
 * @returns {Promise<boolean>} whether the signal was accepted (resolves, never rejects).
 */
export async function signalTyping(id, typing = true) {
  try {
    const response = await apiFetch(`/api/v1/conversations/${encodeURIComponent(id)}/typing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typing: typing !== false }),
    });
    return response.ok;
  } catch (err) {
    // Non-fatal: a typing hint that didn't send changes nothing the user relies on.
    console.warn("[api] typing signal failed:", err?.message ?? err);
    return false;
  }
}

/* ─────────────────────────────── Conversations (chat) — self-service (TM-471) ───────────────────
 * Member-facing levers over the caller's OWN thread membership, WITHOUT touching their event RSVP:
 * mute / unmute this thread's push, and leave / rejoin the thread. Each POSTs to the owner-scoped
 * endpoint and returns the caller's fresh membership state (`{ conversationId, notificationsMuted,
 * left }`) so the Chat view can reflect the new control without a refetch. They throw an {@link
 * ApiError} carrying `.status` + the backend's problem `detail`, so the caller can surface the honest
 * reason — notably rejoin's 409 ("you're no longer attending this event") and leave's 409 ("the
 * organiser can't leave"). A 401 will already have refreshed/redirected via {@link apiFetch}.
 * ---------------------------------------------------------------------------------------------- */

/** POST a self-service membership action ({@code mute|unmute|leave|rejoin}); returns the fresh state. */
async function conversationMembershipAction(id, action) {
  const response = await apiFetch(`/api/v1/conversations/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await toApiError(response, `Couldn't ${action} this chat (${response.status}). Please try again.`);
  }
  return response.json();
}

/**
 * POST /api/v1/conversations/{id}/mute — self-mute this thread's push (TM-471). The caller stays an
 * active, visible member (still reads + posts); only new-message push is silenced.
 * @param {number|string} id the conversation id.
 * @returns {Promise<{conversationId: number, notificationsMuted: boolean, left: boolean}>}
 * @throws {ApiError} on a non-2xx response.
 */
export async function muteConversation(id) {
  return conversationMembershipAction(id, "mute");
}

/**
 * POST /api/v1/conversations/{id}/unmute — restore this thread's push (TM-471), the inverse of
 * {@link muteConversation}.
 * @param {number|string} id the conversation id.
 * @returns {Promise<{conversationId: number, notificationsMuted: boolean, left: boolean}>}
 * @throws {ApiError} on a non-2xx response.
 */
export async function unmuteConversation(id) {
  return conversationMembershipAction(id, "unmute");
}

/**
 * POST /api/v1/conversations/{id}/leave — self-leave this thread (TM-471): hide/exit it while the
 * caller's event RSVP is unchanged (still GOING). A 409 means the caller is the organiser (who can't
 * leave their own thread).
 * @param {number|string} id the conversation id.
 * @returns {Promise<{conversationId: number, notificationsMuted: boolean, left: boolean}>}
 * @throws {ApiError} on a non-2xx response.
 */
export async function leaveConversation(id) {
  return conversationMembershipAction(id, "leave");
}

/**
 * POST /api/v1/conversations/{id}/rejoin — rejoin a thread the caller had left (TM-471), available
 * while they still attend the event. A 409 carries the "you're no longer attending" reason.
 * @param {number|string} id the conversation id.
 * @returns {Promise<{conversationId: number, notificationsMuted: boolean, left: boolean}>}
 * @throws {ApiError} on a non-2xx response.
 */
export async function rejoinConversation(id) {
  return conversationMembershipAction(id, "rejoin");
}

/* ─────────────────────────────── Message reactions (TM-461 / TM-462) ─────────────────────────────
 * Toggle an emoji reaction on a single message. These are MESSAGE-scoped (not conversation-scoped) —
 * the path key is the message id. Both return the message's AUTHORITATIVE MessageReactionSummary
 * (`{ messageId, reactions: EmojiReactionCount[] }`) so the caller can reconcile its optimistic chip
 * math (chat-core.applyReactionToggle) with the server's true per-emoji counts + `mine` flags. They
 * throw an {@link ApiError} carrying `.status` + the backend's problem detail so the UI can roll the
 * optimistic change back and surface an honest reason.
 * ---------------------------------------------------------------------------------------------- */

/**
 * POST /api/v1/messages/{messageId}/reactions — add the caller's `emoji` reaction to a message (TM-461).
 * Body is a ReactionRequest (`{ emoji }`, maxLength 32). Returns the fresh MessageReactionSummary.
 * @param {number|string} messageId the message to react to.
 * @param {string} emoji the reaction glyph (one of chat-core REACTION_EMOJIS).
 * @returns {Promise<{messageId: number, reactions: {emoji: string, count: number, mine: boolean}[]}>}
 * @throws {ApiError} on a non-2xx response.
 */
export async function reactToMessage(messageId, emoji) {
  const response = await apiFetch(`/api/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ emoji: String(emoji ?? "") }),
  });
  if (!response.ok) {
    throw await toApiError(response, `Couldn't add your reaction (${response.status}). Please try again.`);
  }
  return response.json();
}

/**
 * DELETE /api/v1/messages/{messageId}/reactions?emoji=… — remove the caller's `emoji` reaction from a
 * message (TM-461). The emoji is a query param (the endpoint's contract). Returns the fresh summary.
 * @param {number|string} messageId the message to un-react from.
 * @param {string} emoji the reaction glyph to remove.
 * @returns {Promise<{messageId: number, reactions: {emoji: string, count: number, mine: boolean}[]}>}
 * @throws {ApiError} on a non-2xx response.
 */
export async function unreactFromMessage(messageId, emoji) {
  const query = emoji ? `?emoji=${encodeURIComponent(emoji)}` : "";
  const response = await apiFetch(`/api/v1/messages/${encodeURIComponent(messageId)}/reactions${query}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await toApiError(response, `Couldn't remove your reaction (${response.status}). Please try again.`);
  }
  return response.json();
}

/**
 * GET /api/v1/conversations/{id}/stream — open the LIVE chat stream for a thread (TM-464). This is the
 * live-while-online path: while the connection is up, `onMessage` fires with each newly-posted
 * ConversationMessageResponse (`{ id, senderId, body, deepLink, system, reactions[], createdAt }`) the
 * instant the server broadcasts it, so an open thread updates without polling.
 *
 * <p><b>Why fetch + a stream reader, not the native `EventSource`.</b> `EventSource` cannot set an
 * `Authorization` header, but the backend authenticates every request with the Firebase bearer token
 * (there is no cookie/query-token path). So we open the stream with {@link fetch} — which lets us
 * attach the same `Bearer` token every other call uses — and parse the SSE frames off the response
 * body with the pure {@link createSseParser} (chat-core.js).
 *
 * <p><b>Graceful fallback (an AC).</b> The stream is a pure latency optimisation over
 * store-and-forward — every message is also persisted, pushed, and re-fetched on open. So this helper
 * never throws to the caller: a failed connect, a dropped socket, or a parse error just invokes
 * `onError` (best-effort) and stops. The caller keeps its fetched history and, on the next open /
 * reconnect, re-syncs via {@link getConversationMessages}. Nothing is delivered ONLY over the socket.
 *
 * <p><b>Typing indicators (TM-465).</b> The same stream also carries transient {@code typing} events
 * (a small {@code { userId, name, typing }} signal); when one arrives `onTyping` fires with it. Like
 * `message` it's best-effort — a client that never connects simply shows no typing hints — but unlike
 * `message` it is EPHEMERAL (never persisted, nothing to re-sync): a reconnect just starts with no
 * typists. The typist is excluded server-side from their own broadcast, so `onTyping` never fires for
 * the caller's own typing.
 *
 * <p><b>Edit / delete (TM-467).</b> The stream also carries {@code message-edited} (an author reworded a
 * message — payload the edited ConversationMessageResponse, applied as a body/{@code editedAt} PATCH) and
 * {@code message-deleted} (an author took a message back — payload a small {@code { messageId }}). When
 * one arrives `onEdited` / `onDeleted` fires. Both are best-effort like `message`: a client that misses
 * them re-syncs the corrected timeline over the read API on its next poll (the read filters deleted rows
 * out and carries the current body).
 *
 * @param {number|string} id the conversation id to subscribe to.
 * @param {{onMessage?: (msg: Object) => void, onEdited?: (msg: Object) => void, onDeleted?: (ack: Object) => void, onTyping?: (sig: Object) => void, onOpen?: () => void, onError?: (err: Error) => void}} [handlers]
 * @returns {{close: () => void}} a handle; call `close()` to end the stream (e.g. on leaving the thread).
 */
export function openConversationStream(id, { onMessage, onEdited, onDeleted, onTyping, onOpen, onError } = {}) {
  // AbortController lets close() actually tear down the underlying HTTP connection, not just stop reading.
  const controller = new AbortController();
  let closed = false;

  (async () => {
    try {
      const token = await getIdToken();
      const headers = new Headers({ Accept: "text/event-stream" });
      if (token) headers.set("Authorization", `Bearer ${token}`);

      const response = await fetch(
        resolveUrl(`/api/v1/conversations/${encodeURIComponent(id)}/stream`),
        { headers, signal: controller.signal, cache: "no-store" },
      );
      // A non-2xx (e.g. 403 not-a-member, 401) or a bodyless response → fall back silently to polling.
      if (!response.ok || !response.body) {
        onError?.(new Error(`chat stream ${id} failed: ${response.status}`));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      onOpen?.();

      // Read the byte stream to completion, feeding decoded text through the SSE parser and dispatching
      // each `message` event's JSON payload. `done` (server closed / timed out) simply ends the loop —
      // the caller re-syncs on its next open, so a recycled connection loses nothing.
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          // We dispatch four frame types: `message` (a new bubble), `message-edited` / `message-deleted`
          // (TM-467, an author reworded / took back their message), and `typing` (TM-465, a transient
          // indicator). `open` / `:keep-alive` heartbeats carry no payload and are ignored.
          if (
            event.event !== "message"
            && event.event !== "message-edited"
            && event.event !== "message-deleted"
            && event.event !== "typing"
          ) continue;
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            continue; // a malformed frame is skipped, never fatal
          }
          if (event.event === "typing") onTyping?.(payload);
          else if (event.event === "message-edited") onEdited?.(payload);
          else if (event.event === "message-deleted") onDeleted?.(payload);
          else onMessage?.(payload);
        }
      }
    } catch (err) {
      // AbortError is our own close() — not a real failure, so don't surface it.
      if (!closed && err?.name !== "AbortError") onError?.(err);
    }
  })();

  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}

/**
 * GET /api/v1/admin/users/push-routes — the deep-link route allow-list (TM-360): the app hash routes
 * a broadcast/test-push may deep-link to. This is the single source of truth the compose picker
 * (TM-365) populates its dropdown from, so an admin only ever picks a route the send path will accept
 * (no free text, no client copy that can drift). ADMIN-gated on the backend; a non-admin gets a 403.
 * Returns the raw `{ routes: string[] }` body so the caller can normalise it (routeOptionsFrom); a
 * 401 will already have refreshed/redirected via {@link apiFetch}.
 *
 * @returns {Promise<{routes: string[]}>}
 * @throws {ApiError} on a non-2xx response.
 */
export async function getPushRoutes() {
  const response = await apiFetch("/api/v1/admin/users/push-routes", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw await toApiError(response, `Could not load deep-link routes (${response.status}).`);
  }
  return response.json();
}

/**
 * POST /api/v1/admin/push/broadcast — send a custom notification (title + body + optional deep-link
 * route) to a chosen set of accounts (TM-363 endpoint → TM-365 compose UI). Modelled on
 * {@link updateMe}: JSON in/out, and a non-2xx is parsed as RFC-7807 and thrown as an {@link ApiError}
 * (a 400 carries per-field `errors`; an off-list route is a clean 400 from the service). A missing user
 * or a user with no devices is NOT an error — it's reported in the per-recipient result — so a
 * well-formed request resolves with the aggregate + per-recipient outcomes. Pass `route: null` (or omit
 * it) for no deep-link. A 401 will already have refreshed/redirected via {@link apiFetch}.
 *
 * @param {{title: string, body: string, route?: ?string, userIds: number[]}} payload
 * @returns {Promise<{requested: number, sent: number, skipped: number, targeted: number, delivered: number, pruned: number, failed: number, recipients: Object[]}>}
 * @throws {ApiError}
 */
export async function adminBroadcastPush({ title, body, route, userIds }) {
  const response = await apiFetch("/api/v1/admin/push/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // Omit `route` entirely when there's no deep-link (null is also accepted server-side).
    body: JSON.stringify(route ? { title, body, route, userIds } : { title, body, userIds }),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    const message = problem.detail || problem.title || `Broadcast failed (${response.status})`;
    throw new ApiError(response.status, message, fieldErrors);
  }
  return response.json();
}

/**
 * POST /api/v1/admin/messages — send an admin message (title + body + optional deep-link) to a
 * resolved audience of ONE target type (TM-441 endpoint → TM-443 compose UI). The body is built by
 * admin-messages-core.buildAdminMessagePayload: `{ title, body, deepLink?, userIds | cities | eventIds }`
 * with exactly one audience dimension present. Modelled on {@link adminBroadcastPush}: JSON in/out, and
 * a non-2xx is parsed as RFC-7807 and thrown as an {@link ApiError} — a 400 carries per-field `errors`
 * (a title/body over cap, or "provide exactly one target type"), an off-list deep-link is a clean 400,
 * and an audience that resolves to nobody is a 400 with the service's message. On success the backend
 * writes a durable inbox notification per recipient and fans out a best-effort push, returning the
 * campaign + delivery counts (AdminMessageResponse) so the caller can toast an honest summary. A 401
 * will already have refreshed/redirected via {@link apiFetch}.
 *
 * @param {{title: string, body: string, deepLink?: string, userIds?: number[], cities?: string[], eventIds?: number[]}} payload
 * @returns {Promise<{id: number, targetType: string, recipientCount: number, notified: number, pushTargeted: number, pushDelivered: number, pushPruned: number, pushFailed: number, pushSkipped: number}>}
 * @throws {ApiError}
 */
export async function sendAdminMessage(payload) {
  const response = await apiFetch("/api/v1/admin/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    const fieldErrors = Array.isArray(problem.errors) ? problem.errors : [];
    const message = problem.detail || problem.title || `Send failed (${response.status})`;
    throw new ApiError(response.status, message, fieldErrors);
  }
  return response.json();
}

/**
 * GET /api/v1/admin/messages — the calling admin's sent-message history (TM-442 endpoint → TM-444
 * sent-history view). Newest-first, paged, in the shared page envelope
 * `{ items, page, size, totalElements, totalPages }` (zero-based `page`). Each item is an
 * AdminSentHistoryResponse header row — `{ id, sentAt, sentByUid, title, deepLink, audienceType,
 * audienceRef, recipientCount, status }` (deliberately header-only: the endpoint projects the campaign
 * header, not the message body). ADMIN-gated on the backend; a non-admin gets a 403 (surfaced as a
 * friendly {@link ApiError}) and a 401 will already have refreshed/redirected via {@link apiFetch}.
 * `sort` is allow-listed server-side to time/identity, so an unknown property is a clean 400.
 *
 * @param {{page?: number, size?: number, sort?: string}} [opts]
 * @returns {Promise<{items: Object[], page: number, size: number, totalElements: number, totalPages: number}>}
 * @throws {ApiError}
 */
export async function listSentAdminMessages({ page, size, sort } = {}) {
  const params = new URLSearchParams();
  if (page != null) params.set("page", String(page));
  if (size != null) params.set("size", String(size));
  if (sort != null) params.set("sort", sort);
  const query = params.toString();
  const response = await apiFetch(`/api/v1/admin/messages${query ? `?${query}` : ""}`, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 403) {
    throw new ApiError(403, "You need an admin role to view sent messages.");
  }
  if (!response.ok) {
    throw await toApiError(response, `Could not load sent messages (${response.status}).`);
  }
  return response.json();
}

/**
 * POST /api/v1/admin/messages/{id}/recall — recall (unsend) a message the admin previously sent
 * (TM-473 endpoint → the recall control in admin-messages.js; TM-444 reuses this for sent-history rows).
 * The backend marks the campaign recalled and deletes the durable in-app copies it created, so the
 * message disappears from every recipient's in-app inbox/panel AND their notification bell (the same
 * store). Admin bearer via {@link apiFetch}. Modelled on {@link sendAdminMessage}: JSON out, a non-2xx
 * parsed as RFC-7807 and thrown as an {@link ApiError} — an unknown id or another admin's message is a
 * clean 404 (recall is scoped to the sender; the message is never leaked), and it's idempotent (a second
 * recall returns `removed: 0`). On success returns the recall summary (AdminMessageRecallResponse) so
 * the caller can toast an honest one-line result.
 *
 * <p><b>Best-effort on push:</b> recall removes the in-app copies only — a push already delivered to a
 * recipient's OS notification tray can't be un-sent (surfaced in the recall confirm copy).
 *
 * @param {number|string} id the admin_message campaign id to recall
 * @returns {Promise<{id: number, recalledAt: string, recalledBy: string, removed: number}>}
 * @throws {ApiError}
 */
export async function recallAdminMessage(id) {
  const response = await apiFetch(`/api/v1/admin/messages/${encodeURIComponent(id)}/recall`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, `Could not recall the message (${response.status}).`);
  return response.json();
}

/**
 * GET /api/v1/admin/messages/{id} — one campaign the admin sent, in full INCLUDING its `body` (TM-562
 * endpoint → the TM-444 sent-history expanded row). The sent-history LIST (listSentAdminMessages) is
 * deliberately header-only, so the view calls this by-id detail when a row is expanded, to show the
 * actual message body that was sent. Returns an AdminMessageDetailResponse — the list row's fields plus
 * `body`: `{ id, sentAt, sentByUid, title, body, deepLink, audienceType, audienceRef, recipientCount,
 * status, recalledAt }`. ADMIN-gated + SENDER-SCOPED on the backend: an unknown id or another admin's
 * message is a uniform 404 (surfaced as an {@link ApiError} with `.status === 404`, never leaking the
 * body), a non-admin is a 403, and a 401 will already have refreshed/redirected via {@link apiFetch}.
 *
 * @param {number|string} id the admin_message campaign id to fetch
 * @returns {Promise<{id: number, sentAt: string, sentByUid: string, title: string, body: string, deepLink: ?string, audienceType: string, audienceRef: string, recipientCount: number, status: string, recalledAt: ?string}>}
 * @throws {ApiError}
 */
export async function getAdminMessage(id) {
  const response = await apiFetch(`/api/v1/admin/messages/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 403) {
    throw new ApiError(403, "You need an admin role to view this message.");
  }
  if (!response.ok) throw await toApiError(response, `Could not load the message (${response.status}).`);
  return response.json();
}

/**
 * GET /api/v1/events — the visible-now listing (TM-393), soonest-first, in the shared page envelope
 * `{ items, page, size, totalElements, totalPages }`. Each item is an EventCard
 * (`{ id, heading, locationText, timezone, startAt, endAt, capacity, imagePath, goingCount, myState }`).
 * A 401 will already have refreshed/redirected via {@link apiFetch}.
 *
 * @param {{page?: number, size?: number}} [opts]
 * @returns {Promise<{items: Object[], page: number, size: number, totalElements: number, totalPages: number}>}
 * @throws {ApiError}
 */
export async function listEvents({ page, size } = {}) {
  const params = new URLSearchParams();
  if (page != null) params.set("page", String(page));
  if (size != null) params.set("size", String(size));
  const query = params.toString();
  const response = await apiFetch(`/api/v1/events${query ? `?${query}` : ""}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, `Could not load events (${response.status}).`);
  return response.json();
}

/**
 * GET /api/v1/events/{id} — the full EventDetail (TM-393). A hidden/cancelled/finished event is a
 * 404 (the view renders a friendly "no longer available" state off {@link ApiError}.status === 404).
 * @param {number|string} id
 * @returns {Promise<Object>} the EventDetail.
 * @throws {ApiError}
 */
export async function getEvent(id) {
  const response = await apiFetch(`/api/v1/events/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, `Could not load this event (${response.status}).`);
  return response.json();
}

/**
 * GET /api/v1/events/{id}/entitlement — the AUTHORITATIVE per-event membership entitlement for the
 * caller (TM-476). The backend resolves the caller's tier + first-event credit against the event's
 * price/premium into one decision + charge, so the checkout screen (TM-479) and RSVP agree instead of
 * re-deriving the rule client-side. Returns `{ decision, amountPence, reason }`:
 *   • `decision` — one of `FREE | INCLUDED | PAY | UPGRADE`;
 *   • `amountPence` — the charge in pence (0 for FREE/INCLUDED, the event's price for PAY);
 *   • `reason` — a stable machine code (e.g. `FIRST_EVENT_FREE`, `INCLUDED_DIAMOND`, `PAY_PREMIUM`).
 * A hidden/cancelled/finished event is a 404. Identity comes from the Bearer token, never the body.
 * @param {number|string} eventId
 * @returns {Promise<{decision: string, amountPence: number, reason: string}>}
 * @throws {ApiError}
 */
export async function getEventEntitlement(eventId) {
  const response = await apiFetch(`/api/v1/events/${encodeURIComponent(eventId)}/entitlement`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, `Could not load pricing for this event (${response.status}).`);
  return response.json();
}

/**
 * POST /api/v1/events/{id}/rsvp — RSVP (idempotent). Returns the RsvpResult
 * `{ state: "GOING"|"WAITLISTED", goingCount, waitlistedCount }` telling the caller where they
 * landed. On a rejected command (e.g. a 409 booking-cutoff / one-active-event / age-band conflict,
 * or after start) the backend's specific RFC-7807 `detail` is thrown as an {@link ApiError} so the
 * UI can surface the exact reason rather than a generic error.
 * @param {number|string} id
 * @returns {Promise<{state: string, goingCount: number, waitlistedCount: number}>}
 * @throws {ApiError}
 */
export async function rsvpToEvent(id) {
  const response = await apiFetch(`/api/v1/events/${encodeURIComponent(id)}/rsvp`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, "Could not RSVP. Please try again.");
  return response.json();
}

/**
 * DELETE /api/v1/events/{id}/rsvp — leave the event / waitlist (idempotent). A change after start is a
 * 409 with honest copy, surfaced as an {@link ApiError}.
 *
 * <p>Returns the backend's CancelResult: `{ preview, lateCancel, lateCancelCount, message }` —
 * whether leaving now is (or would be) a LATE cancellation, the resulting strike count,
 * and honest copy to show. Pass `{ preview: true }` for a non-committing dry-run (`?preview=true`) so
 * the UI can pre-warn about a late-cancel strike BEFORE the member confirms; the default commits the
 * leave (TM-525 / TM-414).
 *
 * @param {number|string} id
 * @param {{preview?: boolean}} [opts]
 * @returns {Promise<{preview: boolean, lateCancel: boolean, lateCancelCount: number, message: ?string}|null>}
 * @throws {ApiError}
 */
export async function cancelEventRsvp(id, { preview = false } = {}) {
  const query = preview ? "?preview=true" : "";
  const response = await apiFetch(`/api/v1/events/${encodeURIComponent(id)}/rsvp${query}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, "Could not update your RSVP. Please try again.");
  // Both the commit and the preview dry-run return a CancelResult body; tolerate an empty/204 body.
  return response.status === 204 ? null : response.json().catch(() => null);
}

/**
 * POST /api/v1/events/{id}/claim — claim an open spot from the waitlist (offer cascade, TM-393).
 * Success flips the caller to GOING (returns the RsvpResult). Losing the race is a 409 whose honest
 * copy ("That spot has already been taken — you are still on the waitlist.") is surfaced verbatim
 * via {@link ApiError}.
 * @param {number|string} id
 * @returns {Promise<{state: string, goingCount: number, waitlistedCount: number}>}
 * @throws {ApiError}
 */
export async function claimEventSpot(id) {
  const response = await apiFetch(`/api/v1/events/${encodeURIComponent(id)}/claim`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toApiError(response, "Could not claim the spot. Please try again.");
  return response.json();
}

/**
 * GET /api/v1/link-preview?url=… — the OpenGraph card for a URL that appeared in a chat message
 * (TM-470). The fetch of the target page happens SERVER-SIDE, behind an SSRF guard, so the browser
 * never makes the outbound request; this just asks our backend for the resolved card.
 *
 * <p>Best-effort by contract: link previews are an enhancement, so a failure (a 400 for a
 * disallowed/internal URL, a network blip, a non-2xx) resolves to {@code null} rather than throwing —
 * the chat render hook then simply leaves the raw link as plain text (the AC's "fall back to a plain
 * link"). A 401 will already have been handled by {@link apiFetch}. Returns the raw
 * {@code { url, title, description, imageUrl }} response for {@code normalisePreview} to clean.
 *
 * @param {string} url the URL to preview.
 * @returns {Promise<?{url: string, title: ?string, description: ?string, imageUrl: ?string}>}
 */
export async function getLinkPreview(url) {
  try {
    const response = await apiFetch(`/api/v1/link-preview?url=${encodeURIComponent(url)}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// Bridge for the framework-free page (classic scripts can't `import`).
//
// COMPLETENESS CONTRACT (TM-629): every exported helper in this module MUST be listed here. Modules
// that cannot statically import api.js under Node (the Firebase CDN import chain) — membership-tier.js,
// membership-receipts.js et al — resolve api at runtime off `window.tmApi` per contract TM-457, so a
// helper missing from this object is silently `undefined` at the one moment a user clicks (the TM-629
// finding: `checkout` was exported but never bridged, so a bridge-pattern caller could never start a
// per-event paid checkout). Guarded by web/tools/api-bridge-drift.test.mjs, which fails when an export
// is added without a matching bridge entry.
if (typeof window !== "undefined") {
  window.tmApi = {
    apiFetch,
    getMe,
    updateMe,
    getInterestCatalogue,
    getInterestConfig,
    submitOnboarding,
    completeOnboarding,
    acceptTerms,
    getActiveAlerts,
    getMembership,
    switchTier,
    getSubscription,
    subscriptionCheckout,
    cancelSubscription,
    adminGetUserSubscription,
    getMyOrders,
    checkout,
    resendVerification,
    requestEmailCode,
    verifyEmailCode,
    registerDevice,
    deregisterDevice,
    getNotificationBadge,
    markNotificationsSeen,
    listNotifications,
    markNotificationRead,
    listMyConversations,
    getConversationsUnreadTotal,
    getConversationMessages,
    getConversationMembers,
    markConversationRead,
    postConversationMessage,
    postConversationAnnouncement,
    editConversationMessage,
    deleteConversationMessage,
    reactToMessage,
    unreactFromMessage,
    signalTyping,
    openConversationStream,
    muteConversation,
    unmuteConversation,
    leaveConversation,
    rejoinConversation,
    getPushRoutes,
    adminBroadcastPush,
    sendAdminMessage,
    listSentAdminMessages,
    recallAdminMessage,
    getAdminMessage,
    listEvents,
    getEvent,
    getEventEntitlement,
    rsvpToEvent,
    cancelEventRsvp,
    claimEventSpot,
    getLinkPreview,
    redirectToLogin,
    LOGIN_PATH,
    ApiError,
  };
}
