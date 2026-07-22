// App-shell brand block — pure route rule (TM-885 / TM-886).
//
// The walking-skeleton app shell (index.html) opens <main class="app"> with a brand block: the
// "Circle" wordmark <h1>, the "Find your people — complete your circle" tagline, and the #status
// line app.js fills with "Ready when you are.". That block pre-dates every product screen — it was
// the whole landing surface in TM-49 — and until TM-886 it was only ever scoped OFF on the login
// route (a styles.css :has() rule hides the h1 + tagline there because the sign-in card carries its
// own lockup). On every other route it painted ABOVE the screen's content.
//
// THE BUG (TM-886, reproduced at 390×844): the Profile screen (and the first-run gates) own their
// full-page headers — "Profile" (profile.js), "Complete your profile" (onboarding.js), the terms
// card (terms.js) — so the leftover brand block stacked a second, stray header on top of them. The
// leaked copy ("Find your people…", "Ready when you are.") is the SAME brand copy as the auth
// landing card and the boot splash, which is why the report read as "the auth brand / boot splash
// isn't dismissed" — the splash IS dismissed and the auth card IS hidden; it's this shell block.
//
// THE RULE, kept pure + DOM-free (the `-core` extraction pattern — see tabbar-core.js /
// footer-core.js) so it's unit-tested under plain `node --test`: the brand block hides on exactly
// the routes whose screens render their own full-page header. The DOM half (shell-brand.js) is
// driven from router.js's render() — the single source of truth for route chrome, the same
// mechanism as updateTabbar/updateFooter — NOT by per-screen CSS.
//
// Content-first Home (TM-908): Home NOW opts into this rule too. The follow-up decision flagged on
// TM-886 ("extend to Home/Events if design retires the block there") landed for Home in the top-
// chrome rework (TM-908 Home / TM-909 Events / TM-910 Profile): the walking-skeleton brand block
// (the "Circle" wordmark, the "Find your people…" tagline, the "#status" line) is retired above the
// Home feed so the feed's own "Events near you" heading is the first content. Events (`#/events`) is
// still handled in its OWN lane (TM-909) and adds its route here when it lands. Chat / admin keep the
// global brand chrome for now — extending to them is the same one-line SELF_HEADED addition.

/**
 * The routes whose screens own their full-page header, so the shell brand block must NOT paint
 * above them:
 *   • `#/profile` + `#/profile/public` — the Profile hub / public preview ("Profile" header,
 *     TM-514). THE TM-885/TM-886 screens.
 *   • `#/home` — the signed-in Home feed (TM-512). Content-first (TM-908): the feed leads with its
 *     own "Events near you" heading, so the walking-skeleton wordmark/tagline/#status must not paint
 *     above it. Only the SIGNED-IN Home is affected — the signed-out auth landing is a separate view
 *     (#auth-signed-out on #/login) with its own lockup, untouched by this route rule.
 *   • `#/onboarding` — the first-run / phone completion gate ("Complete your profile" card,
 *     TM-250/TM-880). This is the tab-bar-less gate screen every phone-less account is re-routed
 *     to (mandatory phone, #587) — the screen the TM-885/TM-886 user report was actually looking
 *     at, so leaving the leak there would leave the reported screenshot unchanged.
 *   • `#/terms` — the sibling first-run gate (TM-170), rendered as the same self-headed full-page
 *     card in the same gate chain; scoped together so the two gates can't drift apart visually.
 */
export const SELF_HEADED_ROUTES = Object.freeze(["#/profile", "#/home", "#/onboarding", "#/terms"]);

/**
 * Whether the app-shell brand block (wordmark h1 + tagline + #status line) should be hidden for
 * `route`. A route matches when it equals a self-headed route exactly OR is a sub-path of it
 * (`#/profile/public` → hidden), mirroring the prefix rule tabbar-core's activeTab() uses so a
 * profile sub-route can never regress.
 *
 * Route-driven only (no auth state): these routes are all protected, so a signed-out visitor is
 * bounced off them by the guard before this matters — and hiding the block during that bounce
 * beat is also correct (no flash of stray branding).
 *
 * @param {string} route the current normalised hash route (router.js currentRoute())
 * @returns {boolean} true when the brand block must be hidden
 */
export function shellBrandHidden(route) {
  if (typeof route !== "string" || !route) return false;
  return SELF_HEADED_ROUTES.some((r) => route === r || route.startsWith(`${r}/`));
}
