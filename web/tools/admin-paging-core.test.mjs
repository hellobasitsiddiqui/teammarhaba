// Regression tests for the admin-console page clamp (TM-721). Framework-free — Node's built-in test
// runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG: each admin table (admin.js users, admin-events.js, admin-venues.js) computed its page slice
// as `rows.slice(state.page * pageSize, …)` and only clamped `state.page` afterwards, inside renderPager.
// So when a mutation shrank the filtered set below the current page's start (cancel the last event on
// page 2, disable the last matching user, narrow a search), the table painted a BLANK page — an empty
// slice — while the pager underneath, having clamped too late, read "Page 1 of 1". No repaint corrected
// it. The fix clamps the page index with clampPage() BEFORE slicing, so table and pager agree.

import assert from "node:assert/strict";
import { test } from "node:test";

import { clampPage, pageCount } from "../src/assets/admin-paging-core.js";

test("pageCount is never below 1 (an empty table is 'Page 1 of 1', not 'of 0')", () => {
  assert.equal(pageCount(0, 20), 1);
  assert.equal(pageCount(1, 20), 1);
  assert.equal(pageCount(20, 20), 1);
  assert.equal(pageCount(21, 20), 2);
  assert.equal(pageCount(41, 20), 3);
});

test("clampPage leaves an in-range page untouched", () => {
  // 45 rows @ 20/page = 3 pages (0,1,2); page 1 is valid.
  assert.equal(clampPage(1, 45, 20), 1);
  assert.equal(clampPage(0, 45, 20), 0);
  assert.equal(clampPage(2, 45, 20), 2);
});

test("clampPage pulls a stale page back to the last real page after the set shrinks — THE BUG", () => {
  // Was on page 2 (rows 41+) of a 45-row set; a mutation cut it to 8 rows (one page). Without the clamp,
  // slice(40, 60) of 8 rows is empty → blank table. clampPage brings it to page 0.
  assert.equal(clampPage(2, 8, 20), 0);
  // Shrunk to 25 rows (2 pages, 0 and 1) — page 2 clamps to 1, which has real rows.
  assert.equal(clampPage(2, 25, 20), 1);
});

test("clampPage returns 0 for an empty set (no negative page)", () => {
  assert.equal(clampPage(3, 0, 20), 0);
  assert.equal(clampPage(0, 0, 20), 0);
});

test("clampPage never returns a negative or non-finite page", () => {
  assert.equal(clampPage(-1, 45, 20), 0);
  assert.equal(clampPage(NaN, 45, 20), 0);
});
