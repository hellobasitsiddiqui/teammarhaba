// Regression guard for the admin Users Refresh re-entry lock (TM-721). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG: admin.js loadUsers() (the Refresh button) had NO re-entry guard, unlike its sibling in
// admin-messages.js (which gates on state.usersLoading). A double-click on Refresh started TWO concurrent
// full-account page walks (fetchAllUsers walks EVERY page, 100 at a time), doubling request volume and
// racing two result sets into state.users. THE FIX: bail at the top while a load is already in flight —
// `if (state.loading) return;` — mirroring the sibling.
//
// admin.js can't be imported under `node --test` (api.js → Firebase CDN chain), so this pins the guard
// with a source assertion (the same split membership-route-wiring.test.mjs uses) plus a behavioural proof
// of the state-machine invariant it enforces.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Behavioural: the state.loading latch admits exactly one walk at a time ────────────────────────────

test("a second Refresh while a load is in flight is dropped — only ONE account walk runs", async () => {
  const state = { loading: false, users: [] };
  let walks = 0;
  let release;
  const gate = new Promise((r) => { release = r; });

  async function loadUsers() {
    if (state.loading) return; // ← the TM-721 guard
    state.loading = true;
    try {
      walks++;
      await gate;              // models fetchAllUsers walking every page
      state.users = ["…"];
    } finally {
      state.loading = false;
    }
  }

  const first = loadUsers();   // starts the walk, parks on the gate
  await loadUsers();           // double-click while the first is in flight → dropped
  assert.equal(walks, 1, "the re-entrant Refresh did not start a second concurrent walk");

  release();
  await first;
  assert.equal(state.loading, false, "the latch clears after the walk settles");
  await loadUsers();           // a later Refresh runs again
  assert.equal(walks, 2, "the guard only blocks concurrent runs, not sequential ones");
});

// ── Source guard: admin.js loadUsers keeps the re-entry bail ──────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_SRC = readFileSync(join(HERE, "../src/assets/admin.js"), "utf8");

test("admin.js loadUsers() bails while a load is already in flight", () => {
  const fn = ADMIN_SRC.match(/export async function loadUsers\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, "could not locate loadUsers() in admin.js");
  assert.match(fn[1], /if\s*\(state\.loading\)\s*return;/, "the re-entry guard must be the first thing loadUsers does");
});
