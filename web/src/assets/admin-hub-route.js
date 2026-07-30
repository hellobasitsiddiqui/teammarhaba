// Admin hub — pure route constants + the hub-row model (TM-917 / TM-972). DOM-free and import-safe in
// plain Node, so it's unit-tested under `node --test` like the other admin `*-route.js` modules
// (admin-venues-route.js et al). No DOM, no fetch, no browser globals.
//
// The admin layer's shape (TM-915/TM-916/TM-917): the bottom-bar Admin tab (admins only) opens
// `#/admin`, which is the HUB — a second-level nav listing the admin consoles. The users console,
// which used to live at `#/admin`, moved to `#/admin/users` so the hub has its own front door; the
// other consoles keep their existing hashes. Visibility is UX-only — every route here stays
// server-gated (TM-133 role claim / TM-111 RBAC); the hub just surfaces reachable entries.
//
// TM-972 (admin hub IA — lift-and-shift): the hub rows are now VERB-LED and flat, and two things that
// used to be BURIED inside the users console got their own front-door folds:
//   • "Send notification"  → #/admin/notifications  — the push-broadcast compose + its recipient
//                             picker (lifted out of the users console; the picker reads the user table,
//                             so it moved WITH the broadcast — see admin-notifications.js).
//   • "Developer tools"    → #/admin/ops            — the Operations panel (health / diagnostics /
//                             console links), lifted out of the users console (admin-ops.js).
// The users console (#/admin/users) is now user MANAGEMENT only — table + enable/disable/role/search/
// stats — with NO broadcast compose and NO ops panel.

/** The hub itself — the admin layer's landing route (and the Admin tab's target, TM-916). */
export const ADMIN_HUB_ROUTE = "#/admin";

/** The users console's route after the move off `#/admin` (TM-917). */
export const ADMIN_USERS_ROUTE = "#/admin/users";

/** Send-notification (push broadcast) — its own front-door route (TM-972), lifted out of the users
 *  console. admin-notifications.js mounts it; router.js gates it ADMIN-only like every #/admin route. */
export const ADMIN_NOTIFICATIONS_ROUTE = "#/admin/notifications";

/** Developer tools (the Operations panel) — its own front-door route (TM-972), lifted out of the users
 *  console. admin-ops.js mounts it; router.js gates it ADMIN-only like every #/admin route. */
export const ADMIN_OPS_ROUTE = "#/admin/ops";

/** True only for the exact Send-notification route — the router gates + mounts the notification screen
 *  for it. Kept as an exact-match predicate (mirroring the sibling *-route.js modules) so the one route
 *  string lives in exactly one place, imported by BOTH router.js and admin-notifications.js. */
export function isAdminNotificationsRoute(hash) {
  return hash === ADMIN_NOTIFICATIONS_ROUTE;
}

/** True only for the exact Developer-tools route — the router gates + mounts the ops screen for it. */
export function isAdminOpsRoute(hash) {
  return hash === ADMIN_OPS_ROUTE;
}

/**
 * The hub rows, in display order — VERB-LED, flat (TM-972). Each opens an existing (or newly-lifted)
 * console by its stable hash. Kept here (pure + frozen) so the set + order is unit-tested and the DOM
 * half (admin-hub.js) only renders it.
 * @type {ReadonlyArray<{id: string, label: string, route: string, desc: string}>}
 */
export const ADMIN_HUB_ROWS = Object.freeze([
  { id: "users", label: "Manage users", route: ADMIN_USERS_ROUTE, desc: "Accounts, roles, enable & disable" },
  { id: "events", label: "Manage events", route: "#/admin/events", desc: "Create, edit and cancel events" },
  { id: "venues", label: "Manage venues", route: "#/admin/venues", desc: "The venue catalogue" },
  { id: "interests", label: "Manage interests", route: "#/admin/interests", desc: "The interest catalogue + limits" },
  { id: "cities", label: "Manage cities", route: "#/admin/cities", desc: "The city catalogue + icon/empty-state images" },
  { id: "messages", label: "Send a message", route: "#/admin/messages", desc: "In-app messages + sent history" },
  { id: "notifications", label: "Send notification", route: ADMIN_NOTIFICATIONS_ROUTE, desc: "Push a broadcast to a chosen audience" },
  { id: "ops", label: "Developer tools", route: ADMIN_OPS_ROUTE, desc: "Health, diagnostics and consoles" },
].map((r) => Object.freeze(r)));
