// App footer — pure visibility rules + build-stamp labelling core (TM-666).
//
// The framework-free web SPA (index.html) carries ONE shared <footer class="app-footer"> that every
// surface (web / mobile-web / Android WebView / iOS WebView) inherits. Because the footer lives in the
// shell, its login/marketing fragments were previously painted on EVERY screen. TM-666 scopes them to
// the screens they belong on. This module holds the *pure* rules for that scoping — which footer
// fragment shows for a given (signedIn, route) — plus the pure helper that LABELS the two build-stamp
// values (which is backend, which is web). It has NO DOM or Firebase imports, so it is import-safe in a
// plain Node test (the same extraction pattern as `tabbar-core.js` / `home-core.js`; see
// AGENTIC-LESSONS "extract the pure logic to test it").
//
// The DOM-mounting half lives in `footer.js` (driven by router.js's render() pass, the single source of
// truth for signedIn / route); the markup + styling live in index.html + styles.css.

// The routes the byline is allowed on when signed in. Kept as the bare hash strings (no import of
// router.js — that would pull the whole DOM/Firebase graph into this pure module and break the Node
// test). These MUST stay in sync with router.js's LOGIN / HOME / PROFILE constants; the unit test
// pins the exact values so a drift is caught.
export const LOGIN_ROUTE = "#/login";
export const HOME_ROUTE = "#/home";
export const PROFILE_ROUTE = "#/profile";

// A route counts as "on Profile" for the byline if it's the Profile hub OR a Profile sub-route
// (e.g. #/profile/public), mirroring router.js's isProfileRoute() — the byline sits at the bottom of
// the whole Profile surface, not just the exact hub route.
function isProfileRoute(route) {
  return route === PROFILE_ROUTE || (typeof route === "string" && route.startsWith(`${PROFILE_ROUTE}/`));
}

/**
 * Which login/marketing footer fragments should be visible for the current (signedIn, route) state.
 *
 * The rules (from the TM-666 acceptance criteria):
 *   • serviceStatus — the "Service status" link: LOGIN / logged-out ONLY. It's a public, pre-auth
 *     pointer to the outage page; it has no place on the in-app screens.
 *   • phonePrivacy  — the "phone numbers you enter to sign in by SMS…" note: LOGIN ONLY. It's a
 *     phone-sign-in disclosure that only makes sense at the point of signing in. (Signed-out ⇒ the
 *     login screen is the only signed-out route the shell renders, so "logged-out" and "at login"
 *     coincide here; we anchor it to signed-out for robustness.)
 *   • byline        — "A product of 10xAI": login + Profile + the bottom of Home only. Everywhere
 *     else (Events, Chat, Admin, Notifications, …) it's suppressed so it isn't repeated on every
 *     screen.
 *
 * @param {{signedIn?: boolean, route?: string}} state
 * @returns {{serviceStatus: boolean, phonePrivacy: boolean, byline: boolean}}
 */
export function footerVisibility({ signedIn, route } = {}) {
  const loggedOut = !signedIn;
  return {
    // Service-status + phone-privacy are pre-auth: shown only while signed OUT (the login screen).
    serviceStatus: loggedOut,
    phonePrivacy: loggedOut,
    // The byline shows on login (signed-out) OR — when signed in — on Home or Profile only.
    byline: loggedOut || (Boolean(signedIn) && (route === HOME_ROUTE || isProfileRoute(route))),
  };
}

/**
 * Labels for the two halves of the build/version stamp so it's clear which SHA is the WEB bundle and
 * which is the BACKEND (they deploy independently, TM-610). build-info.js writes textContent only, so
 * these are plain strings (never markup). The single-SHA case (web === api) needs no label — one SHA
 * describes both surfaces — so only the split case is labelled here.
 */
export const BUILD_STAMP_LABELS = Object.freeze({ web: "web", api: "backend" });

/**
 * Format the build stamp text, LABELLING which value is the web build and which is the backend.
 *
 * When the two surfaces are deployed from the same commit (webSha === apiSha) the stamp collapses to a
 * single `<sha>` (optionally with the revision) — one SHA already describes both, so no label is needed.
 * When they've drifted, it splits and each SHA is prefixed with its labelled surface, e.g.
 * `web 08c87f9 · backend a1b2c3d · r00219`, so a stale surface is obvious at a glance.
 *
 * Pure string formatting — no DOM. apiSha may be empty (backend not answered yet / unreachable), in
 * which case only the labelled web SHA shows.
 *
 * @param {{webSha?: string, apiSha?: string, revSuffix?: string}} parts
 * @returns {string}
 */
export function formatBuildStamp({ webSha, apiSha, revSuffix = "" } = {}) {
  const web = webSha || "";
  // No backend answer yet → just the web SHA, labelled so it reads "web <sha>" not a bare hash.
  if (!apiSha) return `${BUILD_STAMP_LABELS.web} ${web}`.trim();
  // Same commit on both surfaces → collapse to one unlabelled SHA (one describes both).
  if (web === apiSha) return `${web}${revSuffix}`;
  // Drifted → split and label each surface.
  return `${BUILD_STAMP_LABELS.web} ${web} · ${BUILD_STAMP_LABELS.api} ${apiSha}${revSuffix}`;
}
