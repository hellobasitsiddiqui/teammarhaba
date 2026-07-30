// Admin city-route helpers (TM-1166) — the pure, browser-free routing math for the admin cities
// console and the full-page create/edit city form. Mirrors admin-venues-route.js exactly.
//
// Routes, all ADMIN-gated in router.js like #/admin/venues:
//   #/admin/cities            → the cities list (incl. retired)
//   #/admin/cities/new        → create a new city
//   #/admin/cities/{id}/edit  → edit the city with that id
//
// Split into its own module for the same two reasons as admin-venues-route.js:
//   1. it's unit-testable WITHOUT a browser — feed it a hash string, assert the parse
//      (admin-cities-route.test.mjs on the `node --test` PR gate);
//   2. it's imported by BOTH router.js (to gate + mount the view) and admin-cities.js (to build the
//      "New city" / "Edit" navigation targets), so the route strings live in exactly one place with
//      no import cycle between those two modules.

/** The admin cities LIST route — where the form returns to on save / cancel / back. */
export const ADMIN_CITIES_ROUTE = "#/admin/cities";

/** The create-form route (no id). */
export const ADMIN_CITY_NEW_ROUTE = `${ADMIN_CITIES_ROUTE}/new`;

const EDIT_SUFFIX = "/edit";

/** The hash a "New city" button navigates to. */
export function adminCityNewHash() {
  return ADMIN_CITY_NEW_ROUTE;
}

/** The hash a row's "Edit" action navigates to; the id is percent-encoded to stay a single safe segment. */
export function adminCityEditHash(id) {
  return `${ADMIN_CITIES_ROUTE}/${encodeURIComponent(String(id))}${EDIT_SUFFIX}`;
}

/** True for the create route or any edit route — i.e. "show the full-page city form for this hash". */
export function isAdminCityFormRoute(hash) {
  return parseAdminCityFormRoute(hash) !== null;
}

/**
 * Parse a hash into the form target it addresses, or null if it isn't a form route.
 *  - `#/admin/cities/new`        → { mode: "create", id: null }
 *  - `#/admin/cities/{id}/edit`  → { mode: "edit", id }   (id URL-decoded)
 * The bare list route `#/admin/cities` — and anything malformed (empty id, nested slashes, a bad
 * percent-escape) — returns null so the router falls through to its default handling.
 */
export function parseAdminCityFormRoute(hash) {
  if (typeof hash !== "string") return null;
  if (hash === ADMIN_CITY_NEW_ROUTE) return { mode: "create", id: null };
  const prefix = `${ADMIN_CITIES_ROUTE}/`;
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
