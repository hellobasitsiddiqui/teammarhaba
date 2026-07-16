// Regression guard for the admin Events / Venues Refresh re-entry lock (TM-751). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG (gap G0, found by the TM-738 coverage audit): admin-events.js loadEvents() and
// admin-venues.js loadVenues() (the Refresh buttons) had NO re-entry guard, unlike the sibling
// loadUsers() in admin.js. A double-click on Refresh started TWO concurrent full-inventory page walks
// (walkPages walks EVERY page), doubling request volume and racing two result sets into state. THE FIX:
// bail at the top while a load is already in flight — `if (state.loading) return;` — mirroring loadUsers().
//
// admin-events.js / admin-venues.js can't be imported under `node --test` (each imports api.js → the
// Firebase CDN chain), so this pins the guard with a source assertion (the same split
// admin-loadusers-reentry.test.mjs uses) plus a behavioural proof of the state-machine invariant.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Behavioural: the state.loading latch admits exactly one walk at a time ────────────────────────────
// One parametrised proof standing in for both loaders — they share the identical guard/latch shape.

for (const label of ["loadEvents", "loadVenues"]) {
  test(`a second Refresh while a ${label} load is in flight is dropped — only ONE walk runs`, async () => {
    const state = { loading: false, items: [] };
    let walks = 0;
    let release;
    const gate = new Promise((r) => { release = r; });

    async function load() {
      if (state.loading) return; // ← the TM-751 guard
      state.loading = true;
      try {
        walks++;
        await gate;              // models walkPages walking every page
        state.items = ["…"];
      } finally {
        state.loading = false;
      }
    }

    const first = load();        // starts the walk, parks on the gate
    await load();                // double-click while the first is in flight → dropped
    assert.equal(walks, 1, "the re-entrant Refresh did not start a second concurrent walk");

    release();
    await first;
    assert.equal(state.loading, false, "the latch clears after the walk settles");
    await load();                // a later Refresh runs again
    assert.equal(walks, 2, "the guard only blocks concurrent runs, not sequential ones");
  });
}

// ── Source guard: both loaders keep the re-entry bail before flipping state.loading ───────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

for (const [file, fn] of [
  ["admin-events.js", "loadEvents"],
  ["admin-venues.js", "loadVenues"],
  ["admin-interests.js", "loadInterests"], // TM-779: the interests console shares the same guard shape
]) {
  test(`${file} ${fn}() bails while a load is already in flight`, () => {
    const src = readFileSync(join(HERE, "../src/assets/", file), "utf8");
    const body = src.match(new RegExp(`export async function ${fn}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert.ok(body, `could not locate ${fn}() in ${file}`);
    assert.match(
      body[1],
      /if\s*\(state\.loading\)\s*return;/,
      "the re-entry guard must be present before state.loading is set",
    );
    // And it must come BEFORE `state.loading = true;` (guard is useless after the latch is flipped).
    const guardIdx = body[1].search(/if\s*\(state\.loading\)\s*return;/);
    const latchIdx = body[1].search(/state\.loading\s*=\s*true;/);
    assert.ok(guardIdx >= 0 && latchIdx >= 0 && guardIdx < latchIdx,
      "the re-entry guard must precede `state.loading = true`");
  });
}
