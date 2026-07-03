// Admin event-form route helpers (TM-426) — the pure, browser-free routing math for the full-page
// create/edit event form.
//
// The admin New event / Edit event form used to open as a modal() popup, which overflowed on short
// viewports and hid the submit button (TM-421). It now lives on its OWN admin page reached by a
// dedicated hash route, so it scrolls with the page (no height cap) and the submit button is always
// reachable. Two routes, both ADMIN-gated in router.js exactly like the #/admin/events list:
//   #/admin/events/new        → create a new event
//   #/admin/events/{id}/edit  → edit the event with that id
//
// Split into its own module (the auth-env.js / splash-env.js pattern) for two reasons:
//   1. It's the one piece of the page/route change that's unit-testable WITHOUT a browser — feed it a
//      hash string, assert the parse (admin-event-route.test.mjs on the `node --test` PR gate).
//   2. It's imported by BOTH router.js (to gate + mount the view) and admin-events.js (to build the
//      "New event" / "Edit" navigation targets), so the route strings live in exactly one place with
//      no import cycle between those two modules.

/** The admin events LIST route — where the form returns to on save / cancel / back. */
export const ADMIN_EVENTS_ROUTE = "#/admin/events";

/** The create-form route (no id). */
export const ADMIN_EVENT_NEW_ROUTE = `${ADMIN_EVENTS_ROUTE}/new`;

const EDIT_SUFFIX = "/edit";

/** The hash a "New event" button navigates to. */
export function adminEventNewHash() {
  return ADMIN_EVENT_NEW_ROUTE;
}

/** The hash a row's "Edit" action navigates to; the id is percent-encoded to stay a single safe segment. */
export function adminEventEditHash(id) {
  return `${ADMIN_EVENTS_ROUTE}/${encodeURIComponent(String(id))}${EDIT_SUFFIX}`;
}

/** True for the create route or any edit route — i.e. "show the full-page event form for this hash". */
export function isAdminEventFormRoute(hash) {
  return parseAdminEventFormRoute(hash) !== null;
}

/**
 * Parse a hash into the form target it addresses, or null if it isn't a form route.
 *  - `#/admin/events/new`        → { mode: "create", id: null }
 *  - `#/admin/events/{id}/edit`  → { mode: "edit", id }   (id URL-decoded)
 * The bare list route `#/admin/events` — and anything malformed (empty id, nested slashes, a bad
 * percent-escape) — returns null so the router falls through to its default handling.
 */
export function parseAdminEventFormRoute(hash) {
  if (typeof hash !== "string") return null;
  if (hash === ADMIN_EVENT_NEW_ROUTE) return { mode: "create", id: null };
  const prefix = `${ADMIN_EVENTS_ROUTE}/`;
  if (hash.startsWith(prefix) && hash.endsWith(EDIT_SUFFIX)) {
    const raw = hash.slice(prefix.length, hash.length - EDIT_SUFFIX.length);
    // A non-empty, single-segment id only (guards odd hashes like `.../ /edit` or `.../a/b/edit`).
    if (raw && !raw.includes("/")) {
      try {
        return { mode: "edit", id: decodeURIComponent(raw) };
      } catch {
        return null; // malformed percent-escape → not a valid form route
      }
    }
  }
  return null;
}
