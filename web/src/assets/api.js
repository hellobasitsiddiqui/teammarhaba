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
 * already verified, so the UI can show a precise message. Resolves on success (204); throws with the
 * HTTP status otherwise (a 401 will already have redirected to login).
 * @returns {Promise<void>}
 */
export async function resendVerification() {
  const response = await apiFetch("/api/v1/me/resend-verification", {
    method: "POST",
    headers: { Accept: "application/problem+json" },
  });
  if (!response.ok) {
    throw new Error(`POST /api/v1/me/resend-verification failed: ${response.status}`);
  }
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

// Bridge for the framework-free page (classic scripts can't `import`).
if (typeof window !== "undefined") {
  window.tmApi = { apiFetch, getMe, updateMe, resendVerification, redirectToLogin, LOGIN_PATH, ApiError };
}
