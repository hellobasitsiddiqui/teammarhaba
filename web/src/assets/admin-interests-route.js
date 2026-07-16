// Admin interest-route helpers (TM-779) — the pure, browser-free routing math for the admin interests
// console and the full-page create/edit interest form. Mirrors admin-venues-route.js exactly.
//
// Routes, all ADMIN-gated in router.js like #/admin/venues:
//   #/admin/interests            → the interests list (+ the inline min/max config panel)
//   #/admin/interests/new        → create a new interest
//   #/admin/interests/{id}/edit  → edit the interest with that id
//
// (The min/max-selection config control lives INLINE on the list view, not on its own route — the backend
// exposes it as a singleton sub-resource, so there's nothing to deep-link.)
//
// Split into its own module for the same two reasons as admin-venues-route.js:
//   1. it's unit-testable WITHOUT a browser — feed it a hash string, assert the parse
//      (admin-interests-route.test.mjs on the `node --test` PR gate);
//   2. it's imported by BOTH router.js (to gate + mount the view) and admin-interests.js (to build the
//      "New interest" / "Edit" navigation targets), so the route strings live in exactly one place with
//      no import cycle between those two modules.

/** The admin interests LIST route — where the form returns to on save / cancel / back. */
export const ADMIN_INTERESTS_ROUTE = "#/admin/interests";

/** The create-form route (no id). */
export const ADMIN_INTEREST_NEW_ROUTE = `${ADMIN_INTERESTS_ROUTE}/new`;

const EDIT_SUFFIX = "/edit";

/** The hash a "New interest" button navigates to. */
export function adminInterestNewHash() {
  return ADMIN_INTEREST_NEW_ROUTE;
}

/** The hash a row's "Edit" action navigates to; the id is percent-encoded to stay a single safe segment. */
export function adminInterestEditHash(id) {
  return `${ADMIN_INTERESTS_ROUTE}/${encodeURIComponent(String(id))}${EDIT_SUFFIX}`;
}

/** True for the create route or any edit route — i.e. "show the full-page interest form for this hash". */
export function isAdminInterestFormRoute(hash) {
  return parseAdminInterestFormRoute(hash) !== null;
}

/**
 * Parse a hash into the form target it addresses, or null if it isn't a form route.
 *  - `#/admin/interests/new`        → { mode: "create", id: null }
 *  - `#/admin/interests/{id}/edit`  → { mode: "edit", id }   (id URL-decoded)
 * The bare list route `#/admin/interests` — and anything malformed (empty id, nested slashes, a bad
 * percent-escape) — returns null so the router falls through to its default handling.
 */
export function parseAdminInterestFormRoute(hash) {
  if (typeof hash !== "string") return null;
  if (hash === ADMIN_INTEREST_NEW_ROUTE) return { mode: "create", id: null };
  const prefix = `${ADMIN_INTERESTS_ROUTE}/`;
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
