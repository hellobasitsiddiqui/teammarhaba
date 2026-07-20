// Regression guards for the TM-938 wave-admin-1 closure fixes. Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Post-TM-916/917/918, `#/admin` is the admin HUB (admin-hub.js → #admin-hub-view) and the users
// console moved to `#/admin/users` (admin.js → #admin-view). Two stragglers survived the closure
// review, and — per the admin-stats-loading.test.mjs precedent — the DOM modules involved can't be
// imported under `node --test`, so both are pinned with source assertions:
//
// 1. golden-path.spec.mjs's conditional admin branch still clicked #nav-admin and asserted
//    #admin-view directly. #nav-admin now opens the hub, so the branch would fail the moment it ran
//    as an admin (it's normally skipped: the journey's fresh user is a normal user). The fixed
//    branch must route via the hub's Users row — exactly like the sibling admin specs
//    (admin-walkthrough / admin-suspend-blocks-api / broadcast-admin) already do.
//
// 2. The broadcast deep-link pickers' ROUTE_LABELS (admin.js + admin-messages.js) still labelled
//    "#/admin" as "Admin console" — but that route now opens the hub, not the users console, so an
//    admin composing a deep-link push would read a label pointing at the wrong destination. Both
//    maps must say "Admin hub".

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 1. golden-path admin branch routes to the users console VIA the hub ─────────────────────────────

test("golden-path admin branch clicks the hub's Users row between #nav-admin and the #admin-view assert", () => {
  const spec = readFileSync(join(HERE, "../e2e/tests/golden-path.spec.mjs"), "utf8");

  // Slice the admin branch: from the #nav-admin click to the first #admin-view assertion after it.
  const navClick = spec.indexOf('clickNav(page, "#nav-admin")');
  assert.ok(navClick !== -1, "golden-path.spec.mjs must still exercise #nav-admin in its admin branch");
  const adminView = spec.indexOf('"#admin-view"', navClick);
  assert.ok(adminView !== -1, "the admin branch must still assert #admin-view after the #nav-admin click");
  const branch = spec.slice(navClick, adminView);

  // The crux: post-hub, #nav-admin opens #admin-hub-view — the branch must confirm the hub showed…
  assert.ok(
    branch.includes("#admin-hub-view"),
    "the admin branch must assert the hub (#admin-hub-view) is shown after clicking #nav-admin",
  );
  // …and reach the users console through the hub's Users row, not expect #admin-view directly.
  assert.ok(
    branch.includes('.admin-hub-row[href="#/admin/users"]'),
    "the admin branch must click the hub's Users row (.admin-hub-row[href=\"#/admin/users\"]) before asserting #admin-view",
  );
});

// ── 2. Both deep-link pickers label #/admin as the hub it now is ────────────────────────────────────

for (const file of ["admin.js", "admin-messages.js"]) {
  test(`${file}: ROUTE_LABELS maps "#/admin" to "Admin hub" (the route opens the hub, not the users console)`, () => {
    const source = readFileSync(join(HERE, "../src/assets", file), "utf8");
    assert.match(
      source,
      /"#\/admin":\s*"Admin hub"/,
      `${file} must label the "#/admin" deep link "Admin hub"`,
    );
    // Belt-and-braces: the retired label must be gone entirely, so it can't sneak back via a merge.
    assert.ok(!source.includes('"Admin console"'), `${file} must not label any route "Admin console"`);
  });
}
