// App footer — DOM wiring (TM-666).
//
// The markup (`<footer class="app-footer">` + the store badges, build stamp, Service-status link,
// phone-privacy note, and 10xAI byline) lives in index.html; the styling lives in styles.css. This
// module is the thin bridge: router.js calls `updateFooter()` from its render() pass (the single
// source of truth for signed-in / current-route), and this reflects that onto the footer — toggling
// the `hidden` attribute on the login/marketing fragments so they only show on the screens they
// belong on (TM-666). The pure rules it applies live in `footer-core.js` (unit-tested in Node); this
// file only touches the DOM.
//
// Why router-driven (not self-wired to hashchange/auth): the fragments' visibility depends on the SAME
// signedIn / route values router already computes each render, so piggy-backing on render() keeps one
// source of truth and avoids a second, drifting state machine (same rationale as tabbar.js).

import { footerVisibility } from "./footer-core.js";
import { isWebViewEnv } from "./auth-env.js";

// The footer fragments TM-666 scopes, by their element id (see index.html).
const STATUS_LINK_ID = "footer-status-link"; // "Service status" link line
const PRIVACY_NOTE_ID = "privacy-policy"; // phone-number privacy note (existing id)
const BYLINE_ID = "footer-byline"; // "A product of 10xAI" line
// TM-1177: the app-download store badges + the build/version stamp are scoped to the Help page +
// signed-out login only (footerVisibility.storeBadges / .versionStamp).
const STORE_BADGES_ID = "app-store-badges"; // "Get the app" store-badges block
const BUILD_INFO_ID = "build-info"; // build/version stamp (filled by build-info.js)

/** Look up an element by id, defensively (never throw if the markup or document isn't present). */
function byId(id) {
  return typeof document !== "undefined" ? document.getElementById(id) : null;
}

/**
 * Reflect the current (signedIn, route) onto the footer's login/marketing fragments.
 *  - Service-status link + phone-privacy note: shown only when signed OUT (the login screen).
 *  - 10xAI byline: shown on login (signed-out) or, when signed in, on Home / Profile only.
 *  - App-download store badges + build/version stamp (TM-1177): shown on the Help page (#/help) +
 *    the signed-out login screen only; hidden on every other screen (Home, Events, Chat, Profile,
 *    all Admin screens).
 * Everywhere else each fragment is hidden via the `hidden` attribute (so the UA
 * `[hidden]{display:none}` rule takes it out of flow — no phantom gap).
 *
 * The store badges keep their SEPARATE Android-WebView hide (app-badges.js, TM-330): inside the
 * native shell they must stay hidden on EVERY route (a "Download for Android" CTA is nonsense while
 * you're already in the app). So the badge toggle here only ever *hides* additionally — it never
 * un-hides in a WebView. On a normal browser page `isWebViewEnv()` is false, so this is inert there.
 *
 * @param {{signedIn: boolean, route: string}} state
 */
export function updateFooter({ signedIn, route } = {}) {
  const { serviceStatus, phonePrivacy, byline, storeBadges, versionStamp } = footerVisibility({
    signedIn,
    route,
  });

  const statusLink = byId(STATUS_LINK_ID);
  if (statusLink) statusLink.hidden = !serviceStatus;

  const privacyNote = byId(PRIVACY_NOTE_ID);
  if (privacyNote) privacyNote.hidden = !phonePrivacy;

  const bylineEl = byId(BYLINE_ID);
  if (bylineEl) bylineEl.hidden = !byline;

  // Store badges: hidden unless the route allows them AND we're not in the native WebView shell
  // (the TM-330 hide wins on every route inside the shell — never un-hide there).
  const badgesEl = byId(STORE_BADGES_ID);
  if (badgesEl) badgesEl.hidden = !storeBadges || isWebViewEnv();

  // Build/version stamp: hidden unless the route allows it (Help + signed-out login).
  const buildInfoEl = byId(BUILD_INFO_ID);
  if (buildInfoEl) buildInfoEl.hidden = !versionStamp;
}
