// Push deep-link parsing (TM-285, epic TM-277) — the pure, browser-free half of the deep-link
// handling, split out of push.js for the same reason push-env.js was: it's the one piece that is
// unit-testable WITHOUT a browser, the Capacitor runtime, or the Firebase SDK. push.js transitively
// imports the Firebase SDK (via auth.js) from a gstatic CDN URL the Node test runner can't load, so
// the payload→route contract would be untestable if it lived there. Here it's a pure function of its
// inputs, so `node --test web/tools/*.test.mjs` (the CI gate) can assert it directly.
//
// WHAT THIS DOES. When the user TAPS a push notification, FCM hands the Capacitor
// `pushNotificationActionPerformed` listener the notification object. The send-push service (TM-284)
// puts the destination in the notification's `data` (FCM data payload), e.g.
//   { "data": { "route": "#/profile" } }      // a hash route, used as-is
//   { "data": { "route": "/profile" } }        // a path — coerced to the hash route "#/profile"
//   { "data": { "url":   "#/admin"   } }        // `url` is accepted as an alias for `route`
// We turn that into a safe in-app hash route, or null when there's nothing usable. This module is
// the trust boundary: it ONLY ever emits a same-app hash route, never an absolute/external URL, so a
// crafted payload can't redirect the WebView off-origin or inject a javascript: navigation.

/**
 * The in-app hash routes a notification is allowed to deep-link to. Mirrors router.js's known views.
 * An unknown/empty route falls back to home, so a tap always lands somewhere sensible rather than on
 * a blank/unknown view. (Kept here as the allow-list so the parse stays pure and testable.)
 */
export const KNOWN_ROUTES = Object.freeze([
  "#/home",
  "#/profile",
  "#/admin",
  "#/help",
  "#/onboarding",
  "#/login",
]);

/** Default landing route when a notification carries no usable destination. */
export const DEFAULT_ROUTE = "#/home";

/**
 * Pull the raw route string out of a notification payload, checking the documented carriers in order:
 * `data.route` then `data.url`, and tolerating the destination sitting at the notification's top
 * level (some senders flatten it). Returns the raw string (untrusted, un-normalised) or null.
 * @param {object|null|undefined} notification the Capacitor notification (or its action's wrapper).
 * @returns {string|null}
 */
export function rawRouteFromNotification(notification) {
  if (!notification || typeof notification !== "object") return null;
  // Capacitor delivers the FCM data payload under `.data`; tolerate a flattened shape too.
  const data = (notification.data && typeof notification.data === "object") ? notification.data : notification;
  const candidate = data.route ?? data.url;
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
}

/**
 * Normalise an untrusted route string to a SAFE in-app hash route, or null if it can't be.
 *
 * Security contract (this is the trust boundary): the result is always one of our KNOWN_ROUTES, i.e.
 * a relative same-app hash. We deliberately reject anything that could escape the app:
 *   - absolute URLs / scheme-relative (`http://…`, `https://…`, `//evil`, `javascript:…`),
 *   - anything that doesn't resolve to a known route.
 * `#/profile`, `/profile`, `profile` all map to `#/profile`; an unknown but otherwise-safe relative
 * route is rejected (caller falls back to DEFAULT_ROUTE) rather than navigated blindly.
 * @param {string|null|undefined} raw
 * @returns {string|null} a known hash route, or null when nothing safe can be derived.
 */
export function normaliseRoute(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s === "") return null;
  // Reject absolute / scheme-relative / scheme'd targets outright — must stay in-app.
  // (`javascript:`, `http:`, `//host`, etc. all caught here before any hash coercion.)
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return null;
  // Coerce shapes to a leading "#/" hash route:  "#/x" stays, "/x" → "#/x", "x" → "#/x", "#x" → "#/x".
  if (s.startsWith("#/")) {
    // already a hash route
  } else if (s.startsWith("#")) {
    s = "#/" + s.slice(1).replace(/^\/+/, "");
  } else if (s.startsWith("/")) {
    s = "#" + s;
  } else {
    s = "#/" + s;
  }
  // Lower-case the route key (routes are lower-case); drop any trailing slash beyond the root.
  s = s.replace(/\/+$/, (m, off) => (off <= 2 ? m : "")).toLowerCase();
  return KNOWN_ROUTES.includes(s) ? s : null;
}

/**
 * The end-to-end parse used by push.js: notification → safe hash route to navigate to, or null when
 * the payload carries no usable destination (caller may then fall back to DEFAULT_ROUTE or ignore).
 * @param {object|null|undefined} notification
 * @returns {string|null}
 */
export function routeFromNotification(notification) {
  return normaliseRoute(rawRouteFromNotification(notification));
}
