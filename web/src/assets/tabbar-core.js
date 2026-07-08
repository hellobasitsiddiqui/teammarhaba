// Bottom tab bar — pure logic core (TM-434).
//
// The framework-free web SPA is the single source for all four surfaces (web / mobile-web / Android
// WebView / iOS WebView). This module holds the *pure* rules the bottom tab bar needs — which tab is
// active for a given hash route, and whether the bar should be shown at all — with NO DOM or Firebase
// imports, so it is import-safe in a plain Node test (the same extraction pattern as
// `async-util.js` / `events-core.js`; see AGENTIC-LESSONS "extract the pure logic to test it").
//
// The DOM-mounting half lives in `tabbar.js` (driven by router.js's render()); the markup + styling
// live in `index.html` + `styles.css`. Keeping the rules here means the tab-selection + visibility
// logic is unit-tested without standing up a browser.

/**
 * The four tabs in their LOCKED order (TM-434 clarification: Home · Events · Chat · Profile — Home
 * first, Profile last, no longer adjustable). Each entry is the tab's stable id (matches the
 * `#tab-<id>` element in index.html), the hash route it navigates to, and the route "prefix" used to
 * decide the active tab (so `#/events/{id}` detail deep-links still light the Events tab).
 *
 * Chat is a PLACEHOLDER route today (a "coming soon" stub, TM-434); when the real Event group chat
 * lands (TM-433) the route/section is swapped underneath with no change to this table or the nav.
 */
export const TABS = Object.freeze([
  { id: "home", route: "#/home", prefix: "#/home" },
  { id: "events", route: "#/events", prefix: "#/events" },
  { id: "chat", route: "#/chat", prefix: "#/chat" },
  { id: "profile", route: "#/profile", prefix: "#/profile" },
]);

/** The tab ids, in locked order (handy for tests / DOM iteration). */
export const TAB_IDS = Object.freeze(TABS.map((t) => t.id));

/**
 * Which tab is "active" for a hash route, or `null` when the current route isn't one of the tabs
 * (e.g. `#/admin`, `#/help`, `#/login`, `#/diagnostics` — no tab is highlighted there).
 *
 * A tab matches when the route equals its route exactly OR is a sub-path of it (`#/events/{id}` →
 * Events; a future `#/chat/{eventId}` → Chat), so a detail deep-link still reflects the right tab.
 * Order matters only in that each prefix is distinct, so the first match is the only match.
 *
 * @param {string} hash the current `window.location.hash` (e.g. "#/events/42")
 * @returns {("home"|"events"|"chat"|"profile"|null)}
 */
export function activeTab(hash) {
  if (typeof hash !== "string" || !hash) return null;
  for (const tab of TABS) {
    if (hash === tab.prefix || hash.startsWith(`${tab.prefix}/`)) return tab.id;
  }
  return null;
}

/**
 * Whether the bottom tab bar should be shown for the current session state.
 *
 * It is the PRIMARY navigation for a signed-in, onboarded user only — exactly the same gate as the
 * current Events/Profile nav links (router.js). It is hidden on the auth / onboarding / terms gates:
 *   • signed-out  → hidden (there are no app sections to tab between yet).
 *   • gated       → hidden (a not-yet-onboarded user, or one who still owes terms acceptance, is held
 *                   on the gate; showing tabs would let them side-step it — router's `gated` flag is
 *                   `signedIn && (!isOnboarded || needsTerms)`).
 * The CSS breakpoint separately restricts it to narrow / mobile viewports (desktop keeps the top nav),
 * so this rule is purely the auth/onboarding gate, not the viewport check.
 *
 * @param {{signedIn: boolean, gated: boolean}} state
 * @returns {boolean}
 */
export function shouldShowTabbar({ signedIn, gated } = {}) {
  return Boolean(signedIn) && !gated;
}
