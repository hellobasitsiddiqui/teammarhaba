// Regression guards for the TM-938 wave-admin-1 closure fixes. Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Post-TM-916/917/918, `#/admin` is the admin HUB (admin-hub.js → #admin-hub-view) and the users
// console moved to `#/admin/users` (admin.js → #admin-view). Two stragglers survived the closure
// review, and — per the admin-stats-loading.test.mjs precedent — the DOM modules involved can't be
// imported under `node --test`, so both are pinned with source assertions:
//
// 1. golden-path.spec.mjs's conditional admin branch still clicked the admin nav entry and asserted
//    #admin-view directly. The admin entry now opens the hub, so the branch would fail the moment it
//    ran as an admin (it's normally skipped: the journey's fresh user is a normal user). The fixed
//    branch must route via the hub's Users row — exactly like the sibling admin specs
//    (admin-walkthrough / admin-suspend-blocks-api / broadcast-admin) already do. (TM-1043: the
//    admin nav entry is the tab bar's #tab-admin — the old top-nav #nav-admin was deleted with the
//    .app-nav.)
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

test("golden-path admin branch clicks the hub's Users row between #tab-admin and the #admin-view assert", () => {
  const spec = readFileSync(join(HERE, "../e2e/tests/golden-path.spec.mjs"), "utf8");

  // Slice the admin branch: from the #tab-admin click to the first #admin-view assertion after it.
  const navClick = spec.indexOf('clickNav(page, "#tab-admin")');
  assert.ok(navClick !== -1, "golden-path.spec.mjs must still exercise #tab-admin in its admin branch");
  const adminView = spec.indexOf('"#admin-view"', navClick);
  assert.ok(adminView !== -1, "the admin branch must still assert #admin-view after the #tab-admin click");
  const branch = spec.slice(navClick, adminView);

  // The crux: post-hub, the admin entry opens #admin-hub-view — the branch must confirm the hub showed…
  assert.ok(
    branch.includes("#admin-hub-view"),
    "the admin branch must assert the hub (#admin-hub-view) is shown after clicking #tab-admin",
  );
  // …and reach the users console through the hub's Users row, not expect #admin-view directly.
  assert.ok(
    branch.includes('.admin-hub-row[href="#/admin/users"]'),
    "the admin branch must click the hub's Users row (.admin-hub-row[href=\"#/admin/users\"]) before asserting #admin-view",
  );
});

// ── 2. Both deep-link pickers label #/admin as the hub it now is ────────────────────────────────────
// TM-972: the push-broadcast deep-link picker (with its ROUTE_LABELS) moved OUT of the users console
// (admin.js) into its own screen (admin-notifications.js) when "Send notification" was lifted to its own
// hub fold. The in-app message compose picker (admin-messages.js) is unchanged. Both must still label
// "#/admin" as the hub — a stale "Admin console" label would point an admin's deep-link at the wrong page.

for (const file of ["admin-notifications.js", "admin-messages.js"]) {
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

// ── 3. Review-pass extensions: the two remaining "Admin console" stragglers (same stale-label class) ─

test('index.html: the #admin-hub-view region announces "Admin hub" to assistive tech', () => {
  const html = readFileSync(join(HERE, "../src/index.html"), "utf8");
  assert.match(
    html,
    /id="admin-hub-view"[^>]*aria-label="Admin hub"/,
    'the hub region must carry aria-label="Admin hub" — "Admin console" collides with the real console regions',
  );
});

test('tour-highlights.js: the #tab-admin site-tour coachmark describes the hub, not the users console', () => {
  const source = readFileSync(join(HERE, "../src/assets/tour-highlights.js"), "utf8");
  assert.ok(
    !source.includes('"Admin console"'),
    "tour-highlights.js must not title any coachmark \"Admin console\" — #tab-admin opens the hub now",
  );
  // The admin step exists and is titled for the hub. TM-1043 re-pointed the coachmark from the deleted
  // top-nav #nav-admin to the tab bar's admin tab #tab-admin.
  const step = source.indexOf('target: "#tab-admin"');
  assert.ok(step !== -1, "the site tour must still include a #tab-admin step");
  assert.ok(
    source.slice(step, step + 200).includes('"Admin hub"'),
    'the #tab-admin coachmark must be titled "Admin hub"',
  );
});
