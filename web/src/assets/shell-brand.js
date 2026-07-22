// App-shell brand block — DOM bridge (TM-885 / TM-886).
//
// The thin DOM half of the shell-brand rule: router.js calls `updateShellBrand()` from its render()
// pass (the single source of truth for signed-in / route state — the same driving mechanism as
// updateTabbar / updateFooter), and this reflects the pure shell-brand-core.js verdict onto the
// three brand elements: the "Circle" wordmark <h1>, the "Find your people — complete your circle"
// tagline, and the #status line ("Ready when you are.", app.js).
//
// Visibility is driven with the `hidden` ATTRIBUTE — like every other piece of router-owned chrome —
// because styles.css's `[hidden] { display: none !important }` guarantees it wins over any class
// display rule (the TM-141 lesson). The elements stay IN the DOM: verify-banner.js anchors its
// banner "afterend" of #status, and the login route's styles.css :has() rule reads
// `#auth-signed-out:not([hidden])` — neither cares about these elements' own hidden state.
//
// Why router-driven and not self-wired to hashchange: the same reasoning as tabbar.js — the block's
// visibility depends on the route value render() already computes, so piggy-backing on render()
// keeps one source of truth and avoids a second, drifting state machine.

import { shellBrandHidden } from "./shell-brand-core.js";

/**
 * Reflect the current route onto the shell brand block: hidden on the self-headed screens
 * (Profile, the signed-in Home feed, and the first-run gates — see shell-brand-core.js), shown
 * everywhere else. Login keeps its existing CSS scoping (the #auth-signed-out card is a separate
 * view on #/login with its own lockup, so the signed-out landing is unchanged by the Home rule).
 *
 * Fully guarded for a non-DOM (Node) import and for a page without the block (e.g. a test
 * fixture): missing elements are simply skipped.
 *
 * @param {{route: string}} state the normalised current route from router.js render()
 * @param {Document} [doc=document] injectable document for tests.
 */
export function updateShellBrand({ route } = {}, doc = typeof document !== "undefined" ? document : null) {
  if (!doc) return;
  const hide = shellBrandHidden(route);
  // The three brand elements are DIRECT children of <main class="app"> (index.html); #status is
  // looked up by id (it has one), the wordmark + tagline by the same child selectors the login
  // route's CSS scoping uses, so both mechanisms always target the same nodes.
  const targets = [
    doc.querySelector("main.app > h1"),
    doc.querySelector("main.app > .tagline"),
    doc.getElementById("status"),
  ];
  for (const el of targets) {
    if (el) el.hidden = hide;
  }
}
