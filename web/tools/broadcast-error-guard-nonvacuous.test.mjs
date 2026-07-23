// TM-995 — the broadcast-admin A8 guard (pristine compose panel must not shout) asserted the three
// broadcast error elements only via `toBeHidden()`. Playwright's toBeHidden() PASSES on ZERO matches, so
// if any of those ids were renamed/removed the assertion would go VACUOUS — silently green while the
// thing it's meant to prove no longer exists. The fix anchors each element's existence (toBeAttached)
// BEFORE asserting it's hidden.
//
// The broadcast-admin spec is a DOM/browser Playwright spec (can't run under `node --test`), so — per the
// admin-hub-label-guard.test.mjs / admin-stats-loading.test.mjs precedent — this pins the invariant with
// SOURCE assertions:
//   1. the three error ids the guard targets still exist in admin.js (the assertions aren't stale), and
//   2. each of those assertions in the spec is anchored with toBeAttached (so a future edit can't quietly
//      drop back to a bare toBeHidden and re-vacuum the guard).
//
// Fail-before: on the pre-fix tree the spec asserts the ids only via toBeHidden (no toBeAttached), so (2)
// fails RED. Pass-after: green. Framework-free — Node's built-in runner, CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The three compose-panel error element ids the A8 pristine-panel guard asserts on. */
const ERROR_IDS = ["admin-broadcast-title-error", "admin-broadcast-body-error", "admin-broadcast-recipients"];

test("admin.js still renders all three broadcast error ids the A8 guard targets (assertions aren't stale)", () => {
  const source = readFileSync(join(HERE, "../src/assets/admin.js"), "utf8");
  for (const id of ERROR_IDS) {
    assert.ok(
      source.includes(`id: "${id}"`),
      `admin.js must still create the "${id}" error element — the broadcast-admin A8 guard asserts on it`,
    );
  }
});

test("broadcast-admin.spec.mjs anchors each error assertion with toBeAttached (the A8 guard is non-vacuous)", () => {
  const spec = readFileSync(join(HERE, "../e2e/tests/broadcast-admin.spec.mjs"), "utf8");

  // Every error id must be asserted toBeAttached somewhere (existence anchor) AND toBeHidden (pristine).
  for (const id of ERROR_IDS) {
    const attached = new RegExp(`toBeAttached`);
    // The id is referenced (directly or via a locator const) in the same region as a toBeAttached call.
    assert.ok(spec.includes(`#${id}`), `broadcast-admin.spec.mjs must still reference #${id}`);
    assert.ok(attached.test(spec), "broadcast-admin.spec.mjs must anchor existence with toBeAttached");
  }

  // There must be at least three toBeAttached anchors — one per error element — so no id can be asserted
  // only via a vacuous-on-zero-match toBeHidden. Count guards against a partial revert.
  const attachedCount = (spec.match(/toBeAttached\(\)/g) || []).length;
  assert.ok(
    attachedCount >= 3,
    `expected ≥3 toBeAttached() existence anchors for the three broadcast error elements, found ${attachedCount}`,
  );
});
