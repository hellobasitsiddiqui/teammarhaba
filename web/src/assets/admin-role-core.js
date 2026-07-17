// Pure role-label helper for the admin users console (TM-612, tests backfilled in TM-847).
//
// The admin console renders each account's RBAC role as a friendly badge — "Admin" / "User" — rather
// than the raw enum token ("ADMIN" / "USER") the backend sends, matching statusBadge ("Enabled" /
// "Disabled") and the role filter's friendly options so the console reads consistently (TM-612).
//
// admin.js's roleBadge() (the DOM view) can't be imported under `node --test`: it statically imports
// ui.js / api.js, which pull the Firebase SDK from a gstatic CDN URL the plain-Node test runner can't
// load — the SAME reason the rest of the web app splits its pure logic into `*-core.js` siblings
// (admin-ops-core.js, admin-paging-core.js, membership-checkout-core.js …). So the one pure decision —
// role token → display label — lives here where a unit test can cover it directly
// (web/tools/build-info.test.mjs asserts roleBadge's mapping via this function), while roleBadge stays a
// thin span-builder that calls it. The mapping is unchanged: exactly `"ADMIN" → "Admin"`, everything
// else (including "USER") → "User".

/**
 * Map an RBAC role token to its friendly badge label (TM-612). The backend's only non-admin role is
 * "USER", so the console shows "Admin" for the admin role and "User" for everything else — the exact
 * branch admin.js's roleBadge() used inline (`role === "ADMIN" ? "Admin" : "User"`), now importable and
 * tested. Note this owns ONLY the human label; the raw role still drives roleBadge's CSS class, so the
 * badge styling is untouched.
 *
 * @param {string} role the raw role enum token from the backend ("ADMIN" / "USER").
 * @returns {string} "Admin" when the role is exactly "ADMIN", otherwise "User".
 */
export function roleLabel(role) {
  return role === "ADMIN" ? "Admin" : "User";
}
