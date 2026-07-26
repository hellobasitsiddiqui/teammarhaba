// Corner-bell chrome — DOM bridge (TM-910 → TM-1043).
//
// HISTORY: this bridge used to relocate the bell per route — hide the floating .app-nav hamburger
// and toggle an `.app-nav--corner-bell` class so CSS pinned the bell top-right on the
// CORNER_BELL_ROUTES screens. TM-1043 removed the top .app-nav entirely: the bell now lives in the
// standalone #app-topbar (index.html) and is corner-pinned by static CSS (.app-topbar, styles.css)
// on EVERY route, so there is no chrome left to relocate and this bridge is a deliberate no-op.
//
// WHY IT STILL EXISTS: router.js's render() remains the single source of truth for shell chrome
// (shell-brand / tabbar / footer / this), and keeping the seam wired (router.js calls
// updateCornerBell({ route }) every render) means any future route-scoped bell treatment plugs
// back in here without re-plumbing the router. The -core rule + this bridge stay unit-tested
// (web/tools/corner-bell-core.test.mjs), which also pins that the bridge must NOT resurrect any
// nav/toggle DOM meddling — the elements it used to touch no longer exist.
//
// The bell's own visibility (signed-in + un-gated) is owned by updateNotificationBell() (TM-455),
// exactly as before — this module never touched that and still doesn't.

import { bellPinnedToCorner } from "./corner-bell-core.js";

/**
 * Router seam for the corner-bell chrome. Since TM-1043 the bell is ALWAYS corner-pinned by static
 * CSS (.app-topbar) and the .app-nav row no longer exists — there is no DOM to update. The
 * bellPinnedToCorner(route) call is kept so the router seam and the -core rule stay wired +
 * unit-tested; it is true for every real route.
 *
 * @param {{route: string}} state the normalised current route from router.js render()
 * @param {Document} [doc=document] injectable document for tests (unused; kept for seam stability).
 */
export function updateCornerBell({ route } = {}, doc = typeof document !== "undefined" ? document : null) {
  if (!doc) return;
  void bellPinnedToCorner(route);
}
