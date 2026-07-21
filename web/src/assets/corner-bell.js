// Corner-bell chrome — DOM bridge (TM-910).
//
// The thin DOM half of the corner-bell rule: router.js calls `updateCornerBell()` from its render()
// pass (the single source of truth for signed-in / route state — the same driving mechanism as
// updateShellBrand / updateTabbar / updateFooter), and this reflects the pure corner-bell-core.js
// verdict onto the account-nav chrome:
//   • On a corner-bell route (Profile): HIDE the floating hamburger toggle (#nav-toggle) and the
//     collapsible menu group (#nav-items) — the floating menu row above the screen's own heading —
//     and add `.app-nav--corner-bell` to <nav.app-nav> so styles.css pins the still-visible bell
//     (#nav-notif-bell) to the top-right corner on its own.
//   • Off it: restore both to their default router-driven visibility (the class is removed; the
//     toggle/#nav-items lose the `hidden` we set) — so Home/Events/Chat/admin keep the normal nav.
//
// Visibility is driven with the `hidden` ATTRIBUTE — like every other piece of router-owned chrome
// (shell-brand.js) — because styles.css's `[hidden] { display: none !important }` guarantees it wins
// over the .app-nav-toggle / .app-nav-items display rules (the TM-141 lesson). The elements stay IN
// the DOM: nav-toggle.js keeps its listeners wired (they're inert while the row is hidden), and the
// per-link visibility router sets on #nav-items' children is untouched — we only gate the CONTAINER,
// so leaving the corner route restores exactly the state router already computed for those links.
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

  // Hide the floating menu row (toggle + collapsible items group) on corner routes; the bell is a
  // direct child of .app-nav (NOT inside #nav-items) so it survives and gets corner-pinned by CSS.
  const toggle = doc.getElementById("nav-toggle");
  const items = doc.getElementById("nav-items");
  if (toggle) toggle.hidden = corner;
  if (items) items.hidden = corner;
}
