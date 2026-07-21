// Corner-bell chrome — DOM bridge (TM-910).
//
// The thin DOM half of the corner-bell rule: router.js calls `updateCornerBell()` from its render()
// pass (the single source of truth for signed-in / route state — the same driving mechanism as
// updateShellBrand / updateTabbar / updateFooter), and this reflects the pure corner-bell-core.js
// verdict onto the account-nav chrome:
//   • On a corner-bell route (Profile): HIDE the floating hamburger toggle (#nav-toggle) — the only
//     visible half of the floating nav row on the narrow (phone) viewport where the row floats above
//     the screen's own heading — and add `.app-nav--corner-bell` to <nav.app-nav> so styles.css pins
//     the still-visible bell (#nav-notif-bell) to the top-right corner on its own.
//   • Off it: restore the toggle + drop the class — so Home/Events/Chat/admin keep the normal nav.
//
// Why the toggle only, NOT #nav-items: on the narrow (phone) viewport the floating row IS just the
// hamburger + the bell — #nav-items is the COLLAPSED dropdown, already `display:none` until the
// toggle opens it (styles.css `.app-nav:not([data-nav-open]) .app-nav-items`). With the toggle gone
// the menu can never be opened, so the row is gone WITHOUT touching #nav-items. On the wide (desktop)
// viewport the toggle is already `display:none` (CSS), so hiding it is a no-op and #nav-items stays
// the normal inline nav row — a real user (and e2e, e.g. onboarding-to-profile asserting #nav-profile
// visible on #/profile at desktop width) still sees the account links. Hiding the whole #nav-items
// container instead over-reached: it blanked the desktop nav and broke that spec.
//
// Visibility is driven with the `hidden` ATTRIBUTE — like every other piece of router-owned chrome
// (shell-brand.js) — because styles.css's `[hidden] { display: none !important }` guarantees it wins
// over the .app-nav-toggle display rule (the TM-141 lesson). The toggle stays IN the DOM: nav-toggle
// .js keeps its listeners wired (inert while it's hidden), and the per-link visibility router sets on
// #nav-items' children is untouched — leaving the corner route just un-hides the toggle again.
//
// The bell itself is NOT touched here beyond the parent class: its own signed-in/gated visibility is
// owned by updateNotificationBell() (TM-455). This bridge only RELOCATES the already-visible bell;
// on a signed-out/gated view the bell is hidden by its own owner and the corner class is inert.
//
// Why router-driven and not self-wired to hashchange: the same reasoning as shell-brand.js / tabbar
// .js — the treatment depends on the route value render() already computes, so piggy-backing on
// render() keeps one source of truth and avoids a second, drifting state machine.

import { bellPinnedToCorner } from "./corner-bell-core.js";

/**
 * Reflect the current route onto the account-nav chrome: on the corner-bell routes (Profile — see
 * corner-bell-core.js) hide the floating hamburger + nav-items row and pin the bell top-right; show
 * the normal nav row everywhere else.
 *
 * Fully guarded for a non-DOM (Node) import and for a page without the nav (e.g. a test fixture):
 * missing elements are simply skipped.
 *
 * @param {{route: string}} state the normalised current route from router.js render()
 * @param {Document} [doc=document] injectable document for tests.
 */
export function updateCornerBell({ route } = {}, doc = typeof document !== "undefined" ? document : null) {
  if (!doc) return;
  const corner = bellPinnedToCorner(route);

  const nav = doc.querySelector("nav.app-nav");
  if (nav) nav.classList.toggle("app-nav--corner-bell", corner);

  // Hide the floating hamburger on corner routes (the only visible half of the floating row on the
  // phone viewport; a no-op on desktop where CSS already hides it). #nav-items is left alone — see
  // the header note. The bell is a direct child of .app-nav (NOT inside #nav-items) so it survives
  // and gets corner-pinned by CSS.
  const toggle = doc.getElementById("nav-toggle");
  if (toggle) toggle.hidden = corner;
}
