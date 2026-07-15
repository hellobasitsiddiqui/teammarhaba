// Token-target scoping for the authenticated API client — pure logic core (TM-722).
//
// SECURITY (TM-722, TM-655 LOW web-security cluster). `apiFetch` (api.js) attaches the caller's
// Firebase ID token as `Authorization: Bearer <idToken>` so the backend can authenticate the request.
// The bug: `resolveUrl` passed ANY absolute `http(s)://…` URL straight through, and `apiFetch` then
// bolted the bearer token onto it — so a call routed at an attacker-controlled absolute URL would
// EXFILTRATE a live ID token to that origin (a token-exfiltration seam). The token must only ever ride
// on requests to OUR backend: the configured API base URL, or a same-origin request.
//
// This is the pure, framework-free decision (no DOM, no fetch, no Firebase), so Node's test runner can
// import and exercise it directly — api.js itself can't be imported under Node (its Firebase CDN import
// chain is unloadable), so the security-critical predicate lives here and is unit-tested here.

/**
 * The origin (scheme + host + port) of an absolute URL, lowercased, or `null` if it isn't a parseable
 * absolute URL. Same-origin comparison is done on this normalised origin, never on raw string prefixes
 * (so `https://api.example.com.evil.com` can't masquerade as `https://api.example.com`).
 * @param {string} url
 * @returns {string|null}
 */
export function originOf(url) {
  try {
    return new URL(String(url)).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether the Firebase ID token may be attached to a request for `url`.
 *
 * The token is attached ONLY when the target is our own backend:
 *   • a RELATIVE path (e.g. "/api/v1/me") — resolved against the app's own origin, always ours; or
 *   • an ABSOLUTE URL whose origin equals the configured API base's origin; or
 *   • an ABSOLUTE URL whose origin equals the app's current origin (same-origin).
 * Any other absolute URL (a foreign origin, a look-alike host, a `javascript:`/`data:` pseudo-URL) is
 * REFUSED the token — the request may still be made, but it goes out unauthenticated so no bearer token
 * leaks off-origin.
 *
 * @param {string} url the request target, exactly as passed to apiFetch (relative path OR absolute URL).
 * @param {string} apiBaseUrl the configured backend base URL (window.TEAMMARHABA_CONFIG.apiBaseUrl).
 * @param {string|null} [currentOrigin] the app's own origin (window.location.origin); null when unknown.
 * @returns {boolean} true → attach the token; false → send unauthenticated.
 */
export function shouldAttachToken(url, apiBaseUrl, currentOrigin = null) {
  const target = String(url ?? "");
  // A relative path (no scheme) is resolved by fetch against our own origin — always our backend.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("//")) return true;

  const targetOrigin = originOf(target);
  if (!targetOrigin) return false; // unparseable / non-hierarchical (javascript:, data:, mailto:…) — never.

  const apiOrigin = originOf(apiBaseUrl);
  if (apiOrigin && targetOrigin === apiOrigin) return true;

  const selfOrigin = currentOrigin ? originOf(currentOrigin) : null;
  if (selfOrigin && targetOrigin === selfOrigin) return true;

  return false;
}
