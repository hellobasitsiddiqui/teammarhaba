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
 * GET /api/v1/me — the verified caller's profile (TM-107; profile fields added in TM-162).
 * @returns {Promise<Object>} uid, email, displayName, firstName, lastName, city, age, phone,
 *   notificationPref, timezone, locale, role.
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
 * Error carrying the backend's RFC 7807 ProblemDetail so callers can surface field-level
 * validation errors. `fieldErrors` maps field name → message (from the `errors` array the
 * GlobalExceptionHandler attaches on a 400); `detail` is the human-readable summary.
 */
export class ApiError extends Error {
  constructor(status, detail, fieldErrors = {}) {
    super(detail || `Request failed (${status})`);
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * PATCH /api/v1/me — partial profile update (TM-162). Send only the fields to change; the
 * backend leaves omitted fields untouched and re-validates everything. On a validation failure
 * (400) the returned {@link ApiError} carries per-field messages in `fieldErrors`.
 *
 * @param {Object} body the changed profile fields
 * @returns {Promise<Object>} the updated /me document
 * @throws {ApiError} on a non-ok response (a 401 will already have redirected to login).
 */
export async function patchMe(body) {
  const response = await apiFetch("/api/v1/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    const fieldErrors = {};
    for (const e of Array.isArray(problem.errors) ? problem.errors : []) {
      if (e && e.field) fieldErrors[e.field] = e.message || "Invalid value";
    }
    throw new ApiError(response.status, problem.detail || problem.title, fieldErrors);
  }
  return response.json();
}

// Bridge for the framework-free page (classic scripts can't `import`).
if (typeof window !== "undefined") {
  window.tmApi = { apiFetch, getMe, resendVerification, patchMe, redirectToLogin, LOGIN_PATH };
}
