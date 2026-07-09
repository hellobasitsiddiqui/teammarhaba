// Admin compose route helpers (TM-443) — the pure, browser-free routing math for the full-page admin
// message compose form.
//
// The AC (mirroring the event-form page decision, TM-426) requires the compose screen to open as its
// OWN full page on a dedicated admin route — NOT a modal — so the form scrolls and the audience picker
// + Send button stay reachable on any viewport. The compose page lives at:
//
//   #/admin/messages/new   → compose a new admin message
//
// The bare list route `#/admin/messages` is the sent-history / messages list, owned by TM-444 (a later
// wave), so it is deliberately NOT matched here — only the compose sub-route is. Once TM-444 lands its
// list view, the compose page's "back / after-send" target becomes that list; until then it returns to
// the admin console (see admin-messages.js).
//
// Split into its own module (the admin-event-route.js / auth-env.js pattern) so it's unit-testable
// WITHOUT a browser — feed it a hash string, assert the parse (admin-message-route.test.mjs on the
// `node --test` PR gate) — and so the route string lives in exactly one place, imported by BOTH
// router.js (to gate + mount the view) and admin-messages.js (to build navigation targets) with no
// import cycle.

/** The admin messages LIST route — the sent-history surface (TM-444), and where compose returns to
 *  once that view exists. Exported so the one string lives here, not sprinkled across modules. */
export const ADMIN_MESSAGES_ROUTE = "#/admin/messages";

/** The compose-form route (the AC's dedicated `#/admin/messages/new`). */
export const ADMIN_MESSAGE_NEW_ROUTE = `${ADMIN_MESSAGES_ROUTE}/new`;

/** The hash a "Send a message" / "New message" control navigates to. */
export function adminMessageNewHash() {
  return ADMIN_MESSAGE_NEW_ROUTE;
}

/**
 * True only for the compose route — i.e. "show the full-page compose form for this hash". The bare
 * list route `#/admin/messages` (TM-444) and anything else return false, so the router falls through
 * to its default handling for them.
 * @param {unknown} hash
 * @returns {boolean}
 */
export function isAdminMessageComposeRoute(hash) {
  return hash === ADMIN_MESSAGE_NEW_ROUTE;
}

/**
 * True only for the bare sent-history LIST route (`#/admin/messages`, TM-444) — NOT the compose
 * sub-route (`…/new`) and nothing deeper. Kept as its own exact-match predicate (mirroring
 * {@link isAdminMessageComposeRoute}) so the router can gate + mount the list view without re-deriving
 * the string, and so the one route lives in exactly one place. Added additively alongside the compose
 * predicate — the compose route math is untouched.
 * @param {unknown} hash
 * @returns {boolean}
 */
export function isAdminMessageListRoute(hash) {
  return hash === ADMIN_MESSAGES_ROUTE;
}
