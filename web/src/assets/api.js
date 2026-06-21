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

// Where to send the user when authentication can't be established. The actual login
// route/view is owned by the sign-in UI (TM-106) and route guards (TM-109); this is the
// single seam they can repoint or replace. Kept as a path (not a full URL) so it works on
// any host.
export const LOGIN_PATH = "/login";

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
  const here = window.location.pathname + window.location.search;
  window.location.assign(`${LOGIN_PATH}?redirect=${encodeURIComponent(here)}`);
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

// Bridge for the framework-free page (classic scripts can't `import`).
if (typeof window !== "undefined") {
  window.tmApi = { apiFetch, getMe, redirectToLogin, LOGIN_PATH };
}
