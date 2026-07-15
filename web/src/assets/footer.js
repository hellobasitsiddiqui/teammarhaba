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

// The footer fragments TM-666 scopes, by their element id (see index.html).
const STATUS_LINK_ID = "footer-status-link"; // "Service status" link line
const PRIVACY_NOTE_ID = "privacy-policy"; // phone-number privacy note (existing id)
const BYLINE_ID = "footer-byline"; // "A product of 10xAI" line

/** Look up an element by id, defensively (never throw if the markup or document isn't present). */
function byId(id) {
  return typeof document !== "undefined" ? document.getElementById(id) : null;
}

/**
 * Reflect the current (signedIn, route) onto the footer's login/marketing fragments.
 *  - Service-status link + phone-privacy note: shown only when signed OUT (the login screen).
 *  - 10xAI byline: shown on login (signed-out) or, when signed in, on Home / Profile only.
 * Everywhere else each fragment is hidden via the `hidden` attribute (so the UA
 * `[hidden]{display:none}` rule takes it out of flow — no phantom gap). The store badges and the
 * build stamp are NOT scoped here (they're intentionally on every screen).
 *
 * @param {{signedIn: boolean, route: string}} state
 */
export function updateFooter({ signedIn, route } = {}) {
  const { serviceStatus, phonePrivacy, byline } = footerVisibility({ signedIn, route });

  const statusLink = byId(STATUS_LINK_ID);
  if (statusLink) statusLink.hidden = !serviceStatus;

  const privacyNote = byId(PRIVACY_NOTE_ID);
  if (privacyNote) privacyNote.hidden = !phonePrivacy;

  const bylineEl = byId(BYLINE_ID);
  if (bylineEl) bylineEl.hidden = !byline;
}
