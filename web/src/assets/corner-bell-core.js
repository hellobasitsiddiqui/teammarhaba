// Corner-bell chrome — pure route rule (TM-910).
//
// The top-chrome rework (TM-908 Home / TM-909 Events / TM-910 Profile) replaces the floating
// account-nav row — the hamburger toggle (#nav-toggle) plus, on narrow screens, the notification
// bell (#nav-notif-bell) that rides beside it — with a clean surface whose own heading is the first
// content, and the bell pinned to the top-right corner on its own.
//
// This is the Profile slice (TM-910). Profile is ALREADY self-headed (shell-brand-core.js hides the
// walking-skeleton wordmark/tagline/#status there), so the only remaining top chrome above the
// "Profile" heading is the floating .app-nav row. On the corner-bell routes we:
//   • hide the hamburger toggle + the collapsible #nav-items group (the floating menu row), and
//   • pin the bell to the top-right corner (a .app-nav--corner-bell class the DOM bridge toggles),
// so the surface's own heading becomes the first content with the bell in the corner beside it.
//
// Kept pure + DOM-free — the same `-core` extraction pattern as shell-brand-core.js / tabbar-core.js
// / footer-core.js — so the rule is unit-testable under plain `node --test`. The DOM half
// (corner-bell.js) is driven from router.js's render() (the single source of truth for route
// chrome), NOT by per-screen CSS.
//
// CROSS-LANE (TM-908 / TM-909): this module is deliberately self-contained so the Home and Events
// lanes consume the SAME corner-bell treatment by adding their route to CORNER_BELL_ROUTES —
// one owner (this file), the others consume. Those lanes' surfaces are NOT edited here; adding a
// route is a one-line change, mirroring shell-brand-core's SELF_HEADED_ROUTES.
//
// Home slice (TM-908): Home now opts in. Its brand block is retired above the feed (shell-brand-core
// hides the wordmark/tagline/#status there), so — exactly as on Profile — the only remaining top
// chrome above the "Events near you" heading is the floating .app-nav row. Adding `#/home` here
// removes that row and pins the bell to the top-right corner, making the feed heading the first
// content. Events (`#/events`, TM-909) still consumes this from its own lane when it lands.

/**
 * The routes whose screens own their full-page header AND take the corner-bell treatment (floating
 * nav row removed, bell pinned top-right):
 *   • `#/profile` + `#/profile/public` — the Profile hub / public preview ("Profile" header,
 *     TM-514). THE TM-910 screens. (Sign-out already lives on the Profile hub via TM-906 — this
 *     ticket only reshapes the chrome around it.)
 *   • `#/home` — the signed-in Home feed ("Events near you" heading, TM-512/TM-908). Content-first:
 *     with the brand block retired, the floating nav row is removed and the bell corner-pinned so the
 *     feed heading is the first content, mirroring Profile.
 *
 * Events (`#/events`, TM-909) is handled in its OWN lane and adds its route here when it lands —
 * this list is the shared consumption point.
 */
export const CORNER_BELL_ROUTES = Object.freeze(["#/profile", "#/home"]);

/**
 * Whether the corner-bell chrome applies for `route`: the floating hamburger + nav-items row is
 * hidden and the bell is pinned top-right. A route matches when it equals a corner-bell route
 * exactly OR is a sub-path of it (`#/profile/public` → true), mirroring the prefix rule
 * shell-brand-core's shellBrandHidden() and tabbar-core's activeTab() use so a profile sub-route
 * can never regress.
 *
 * Route-driven only (no auth state): these routes are all protected, so a signed-out visitor is
 * bounced off them by the guard before this matters — and applying the treatment during that bounce
 * beat is harmless (the whole nav is hidden signed-out anyway).
 *
 * @param {string} route the current normalised hash route (router.js currentRoute())
 * @returns {boolean} true when the corner-bell chrome must be applied
 */
export function bellPinnedToCorner(route) {
  if (typeof route !== "string" || !route) return false;
  return CORNER_BELL_ROUTES.some((r) => route === r || route.startsWith(`${r}/`));
}
