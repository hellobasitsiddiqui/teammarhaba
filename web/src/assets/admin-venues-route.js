// Admin venue-route helpers (TM-519) — the pure, browser-free routing math for the admin venues
// console and the full-page create/edit venue form. Mirrors admin-event-route.js exactly.
//
// Routes, all ADMIN-gated in router.js like #/admin/events:
//   #/admin/venues            → the venues list
//   #/admin/venues/new        → create a new venue
//   #/admin/venues/{id}/edit  → edit the venue with that id
//
// Split into its own module for the same two reasons as admin-event-route.js:
//   1. it's unit-testable WITHOUT a browser — feed it a hash string, assert the parse
//      (admin-venues-route.test.mjs on the `node --test` PR gate);
//   2. it's imported by BOTH router.js (to gate + mount the view) and admin-venues.js (to build the
//      "New venue" / "Edit" navigation targets), so the route strings live in exactly one place with
//      no import cycle between those two modules.

/** The admin venues LIST route — where the form returns to on save / cancel / back. */
export const ADMIN_VENUES_ROUTE = "#/admin/venues";

/** The create-form route (no id). */
export const ADMIN_VENUE_NEW_ROUTE = `${ADMIN_VENUES_ROUTE}/new`;

const EDIT_SUFFIX = "/edit";

/** The hash a "New venue" button navigates to. */
export function adminVenueNewHash() {
  return ADMIN_VENUE_NEW_ROUTE;
}

/** The hash a row's "Edit" action navigates to; the id is percent-encoded to stay a single safe segment. */
export function adminVenueEditHash(id) {
  return `${ADMIN_VENUES_ROUTE}/${encodeURIComponent(String(id))}${EDIT_SUFFIX}`;
}

/** True for the create route or any edit route — i.e. "show the full-page venue form for this hash". */
export function isAdminVenueFormRoute(hash) {
  return parseAdminVenueFormRoute(hash) !== null;
}

/**
 * Parse a hash into the form target it addresses, or null if it isn't a form route.
 *  - `#/admin/venues/new`        → { mode: "create", id: null }
 *  - `#/admin/venues/{id}/edit`  → { mode: "edit", id }   (id URL-decoded)
 * The bare list route `#/admin/venues` — and anything malformed (empty id, nested slashes, a bad
 * percent-escape) — returns null so the router falls through to its default handling.
 */
export function parseAdminVenueFormRoute(hash) {
  if (typeof hash !== "string") return null;
  if (hash === ADMIN_VENUE_NEW_ROUTE) return { mode: "create", id: null };
  const prefix = `${ADMIN_VENUES_ROUTE}/`;
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
