// Pure role-label mapping for the admin console (TM-612, TM-847). Framework-free — no DOM, no browser
// globals — so Node's test runner imports it directly (the same `*-core.js` split the rest of the admin
// consoles use). Guarded by admin-role-label-core.test.mjs.
//
// TM-612 turned the raw role enum token ("ADMIN"/"USER") into a human-friendly badge label
// ("Admin"/"User"). The mapping lived inline in admin.js's roleBadge() with no coverage (flagged by the
// TM Easy Wins 1 closure review, TM-847). Extracting the mapping verbatim — no behaviour change — makes
// it a real fail-before/pass-after regression guard. admin.js's roleBadge() now calls this for the label
// text; the raw role still drives the CSS class there, so styling is unchanged.

/**
 * Map a role token to its human-friendly badge label. "ADMIN" → "Admin"; every other value (including
 * "USER", an unknown token, or a blank/absent one) → "User" — the safe default that mirrors the
 * fail-safe-to-USER role resolution on the backend (auth.RoleClaims). Pure string mapping, no DOM.
 *
 * @param {string} [role] the raw role enum token from the API (e.g. "ADMIN", "USER").
 * @returns {string} "Admin" for the admin token, else "User".
 */
export function roleLabel(role) {
  return role === "ADMIN" ? "Admin" : "User";
}
