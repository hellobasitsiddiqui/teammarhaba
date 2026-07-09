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

  const send = async (forceRefresh) => {
    const token = await getIdToken(forceRefresh);
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
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
 * <p>Best-effort by contract: a non-2xx or a network error resolves to {@code []} (never throws), so
 * the ~5-minute poll in alerts.js can call it in the app shell without a try/catch and a transient
 * backend blip simply shows no banner.
 *
 * @returns {Promise<Array<{id: number, message: string, level: string, dismissal: string}>>}
 */
export async function getActiveAlerts() {
  try {
    const response = await fetch(resolveUrl("/api/v1/alerts/active"), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
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
 * DELETE /api/v1/events/{id}/rsvp — leave the event / waitlist (idempotent, 204). A change after
 * start is a 409 with honest copy, surfaced as an {@link ApiError}.
 * @param {number|string} id
 * @returns {Promise<void>}
 * @throws {ApiError}
 */
export async function cancelEventRsvp(id) {
  const response = await apiFetch(`/api/v1/events/${encodeURIComponent(id)}/rsvp`, {
    method: "DELETE",
    headers: { Accept: "application/problem+json" },
  });
  if (!response.ok) throw await toApiError(response, "Could not update your RSVP. Please try again.");
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

// Bridge for the framework-free page (classic scripts can't `import`).
if (typeof window !== "undefined") {
  window.tmApi = {
    apiFetch,
    getMe,
    updateMe,
    submitOnboarding,
    completeOnboarding,
    acceptTerms,
    resendVerification,
    requestEmailCode,
    verifyEmailCode,
    registerDevice,
    deregisterDevice,
    getNotificationBadge,
    markNotificationsSeen,
    listNotifications,
    markNotificationRead,
    getPushRoutes,
    adminBroadcastPush,
    sendAdminMessage,
    listSentAdminMessages,
    listEvents,
    getEvent,
    rsvpToEvent,
    cancelEventRsvp,
    claimEventSpot,
    redirectToLogin,
    LOGIN_PATH,
    ApiError,
  };
}
