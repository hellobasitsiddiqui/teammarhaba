// Admin hub — pure route constants + the hub-row model (TM-917). DOM-free and import-safe in plain
// Node, so it's unit-tested under `node --test` like the other admin `*-route.js` modules
// (admin-venues-route.js et al). No DOM, no fetch, no browser globals.
//
// The admin layer's shape (TM-915/TM-916/TM-917): the bottom-bar Admin tab (admins only) opens
// `#/admin`, which is now the HUB — a second-level nav listing the five consoles. The users console,
// which used to live at `#/admin`, moved to `#/admin/users` so the hub has its own front door; the
// four other consoles keep their existing hashes. Visibility is UX-only — every route here stays
// server-gated (TM-133 role claim / TM-111 RBAC); the hub just surfaces reachable entries.

/** The hub itself — the admin layer's landing route (and the Admin tab's target, TM-916). */
export const ADMIN_HUB_ROUTE = "#/admin";

/** The users console's route after the move off `#/admin` (TM-917). */
export const ADMIN_USERS_ROUTE = "#/admin/users";

/**
 * The hub rows, in display order — each opens an existing console by its stable hash (reused as-is;
 * this is nav chrome, not a console rebuild). Kept here (pure + frozen) so the set + order is
 * unit-tested and the DOM half (admin-hub.js) only renders it.
 * @type {ReadonlyArray<{id: string, label: string, route: string, desc: string}>}
 */
export const ADMIN_HUB_ROWS = Object.freeze([
  { id: "users", label: "Users", route: "#/admin/users", desc: "Accounts, roles, enable & disable" },
  { id: "events", label: "Manage events", route: "#/admin/events", desc: "Create, edit and cancel events" },
  { id: "venues", label: "Venues", route: "#/admin/venues", desc: "The venue catalogue" },
  { id: "interests", label: "Interests", route: "#/admin/interests", desc: "The interest catalogue + limits" },
  { id: "messages", label: "Send a message", route: "#/admin/messages", desc: "Broadcast + sent history" },
].map((r) => Object.freeze(r)));
