// Corner-bell chrome — pure route rule (TM-910 → TM-1043).
//
// HISTORY: TM-908/909/910 corner-pinned the notification bell on a per-route allow-list
// (CORNER_BELL_ROUTES) by hiding the floating .app-nav hamburger row and adding a CSS class.
// TM-1043 deleted the top .app-nav entirely — the bell is now STANDALONE fixed chrome
// (#app-topbar / .app-topbar, styles.css) pinned to the top-right of the app clamp band on EVERY
// route, and the bottom tab bar is the single primary nav. There is no longer a per-route decision
// to make: the corner treatment is unconditional.
//
// This module survives as the documented INVARIANT (and the router seam's unit-tested rule): the
// bell is corner-pinned on every real route. `bellPinnedToCorner` is therefore true for any
// non-empty route string and fail-safe false on junk. If a future ticket ever re-introduces
// route-scoped bell chrome, it must consciously edit this rule (and its test,
// web/tools/corner-bell-core.test.mjs) — that friction is the point of keeping the file.
//
// Kept pure + DOM-free — the same `-core` extraction pattern as shell-brand-core.js /
// tabbar-core.js / footer-core.js — so the rule stays unit-testable under plain `node --test`.
// The DOM half (corner-bell.js) is driven from router.js's render() (the single source of truth
// for route chrome).

/**
 * Whether the corner-bell chrome applies for `route`. Since TM-1043 the bell is statically
 * corner-pinned by CSS on every route, so this is TRUE for any real (non-empty string) route and
 * false only on junk input (fail-safe, matching the old rule's junk handling).
 *
 * @param {string} route the current normalised hash route (router.js currentRoute())
 * @returns {boolean} true for every real route (the bell is always corner-pinned)
 */
export function bellPinnedToCorner(route) {
  return typeof route === "string" && route.length > 0;
}
