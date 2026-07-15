// Tests for the admin inventory page-walk (admin-page-walk-core.js, TM-727). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The walk backs both admin consoles (admin-events.js / admin-venues.js). These lock in the contract
// its inline predecessors silently broke: a page failing mid-walk KEEPS the pages that loaded and
// reports `partial`; only a first-page failure surfaces as `error`; and running out the runaway guard
// reports `truncated` instead of pretending the load was complete.

import assert from "node:assert/strict";
import { test } from "node:test";

import { walkPages } from "../src/assets/admin-page-walk-core.js";

// A fake paged endpoint over a fixed item list; `size` per page, `totalPages` reported so the walk can
// stop on the server's signal. Optionally fails on a given page index.
function pagedSource(total, { size, failOnPage = null } = {}) {
  const totalPages = Math.ceil(total / size);
  return async (page) => {
    if (page === failOnPage) throw new Error(`page ${page} failed`);
    const startIndex = page * size;
    const items = [];
    for (let i = startIndex; i < Math.min(startIndex + size, total); i += 1) items.push({ id: i });
    return { items, totalElements: total, totalPages };
  };
}

test("walks every page and reports a clean, complete load", async () => {
  const result = await walkPages(pagedSource(250, { size: 100 }), { pageSize: 100, maxPages: 50 });
  assert.equal(result.items.length, 250);
  assert.equal(result.total, 250);
  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.truncated, false);
  assert.equal(result.error, null);
});

test("a single short page ends the walk immediately (complete)", async () => {
  const result = await walkPages(pagedSource(12, { size: 100 }), { pageSize: 100, maxPages: 50 });
  assert.equal(result.items.length, 12);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
});

test("a page failing MID-WALK keeps what loaded and flags partial (never discards)", async () => {
  // Pages 0 and 1 load (200 items), page 2 throws. The old inline loop threw all 200 away; the walk
  // keeps them and reports partial with no load error.
  const result = await walkPages(pagedSource(500, { size: 100, failOnPage: 2 }), {
    pageSize: 100,
    maxPages: 50,
  });
  assert.equal(result.items.length, 200); // the two pages that loaded survive
  assert.equal(result.partial, true);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, false);
  assert.equal(result.error, null); // a mid-walk failure is NOT a table error — it's surfaced as partial
});

test("a FIRST-page failure (nothing loaded) surfaces as an error with an empty result", async () => {
  const result = await walkPages(pagedSource(500, { size: 100, failOnPage: 0 }), {
    pageSize: 100,
    maxPages: 50,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.partial, false); // nothing loaded, so not "partial" — it's a hard load error
  assert.ok(result.error instanceof Error);
});

test("running out the runaway guard flags truncated (not a silent complete)", async () => {
  // 1000 items at size 100 = 10 pages, but the guard stops at 3 — the walk holds a prefix and must say so.
  const result = await walkPages(pagedSource(1000, { size: 100 }), { pageSize: 100, maxPages: 3 });
  assert.equal(result.items.length, 300);
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.equal(result.partial, false);
  assert.equal(result.error, null);
});

test("total is floored at the item count when the server under-reports", async () => {
  const source = async () => ({ items: [{ id: 1 }, { id: 2 }], totalElements: 0, totalPages: 1 });
  const result = await walkPages(source, { pageSize: 100, maxPages: 50 });
  assert.equal(result.total, 2); // never less than what we actually hold
});
