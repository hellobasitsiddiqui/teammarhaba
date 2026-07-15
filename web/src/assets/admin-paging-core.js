// Pure paging math shared by the admin consoles' tables (admin.js users, admin-events.js, admin-venues.js).
// Framework-free — no DOM, no fetch, no browser globals — so Node's test runner imports it directly (the
// same `*-core.js` split the rest of the web app uses). Guarded by admin-paging-core.test.mjs.
//
// TM-721 (the bug this exists to fix): each renderTable computed its page slice as
// `rows.slice(state.page * pageSize, …)` and only clamped `state.page` LATER, inside renderPager — after
// the (now empty) slice had already been painted, with no repaint. So when a mutation shrank the filtered
// set below the current page's start (e.g. cancelling the last event on page 2), the table painted a
// blank page while the pager underneath read "Page 1 of 1". The fix is to clamp the page index BEFORE
// slicing, using this helper, so the table and pager agree on the first render.

/**
 * The number of pages needed to show `totalRows` at `pageSize` per page — never below 1 (an empty table
 * is still "Page 1 of 1", not "Page 1 of 0"). Mirrors the `Math.ceil` in each console's renderPager.
 * @param {number} totalRows rows in the current (filtered) set.
 * @param {number} pageSize rows shown per page (assumed ≥ 1).
 * @returns {number} page count, ≥ 1.
 */
export function pageCount(totalRows, pageSize) {
  return Math.max(1, Math.ceil(Math.max(0, totalRows) / pageSize));
}

/**
 * Clamp a (possibly stale) page index into the valid range for `totalRows`/`pageSize`. Returns the
 * highest real page when the current index has fallen off the end after the set shrank, 0 when the set is
 * empty, and the index unchanged when it's already in range (and never below 0 for a bad negative index).
 * @param {number} page the current, possibly out-of-range, zero-based page index.
 * @param {number} totalRows rows in the current (filtered) set.
 * @param {number} pageSize rows shown per page (assumed ≥ 1).
 * @returns {number} a valid page index in [0, pageCount-1].
 */
export function clampPage(page, totalRows, pageSize) {
  const last = pageCount(totalRows, pageSize) - 1;
  if (!Number.isFinite(page) || page < 0) return 0;
  return Math.min(page, last);
}
