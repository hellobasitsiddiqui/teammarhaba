// Unit tests for the admin hub's pure route model (TM-917) — routes + the hub-row set/order.
// Framework-free (node:test), picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_HUB_ROUTE,
  ADMIN_USERS_ROUTE,
  ADMIN_HUB_ROWS,
} from "../src/assets/admin-hub-route.js";

test("the hub is #/admin and the users console moved to #/admin/users (TM-917)", () => {
  assert.equal(ADMIN_HUB_ROUTE, "#/admin");
  assert.equal(ADMIN_USERS_ROUTE, "#/admin/users");
});

test("the hub lists all five consoles in order, each with a stable #/admin* route", () => {
  assert.deepEqual(
    ADMIN_HUB_ROWS.map((r) => r.id),
    ["users", "events", "venues", "interests", "messages"],
  );
  assert.deepEqual(
    ADMIN_HUB_ROWS.map((r) => r.route),
    ["#/admin/users", "#/admin/events", "#/admin/venues", "#/admin/interests", "#/admin/messages"],
  );
  // The first row is the moved users console (its route equals ADMIN_USERS_ROUTE).
  assert.equal(ADMIN_HUB_ROWS[0].route, ADMIN_USERS_ROUTE);
});

test("every hub row has a non-empty label + description and an #/admin* route (activeTab lights the Admin tab)", () => {
  for (const row of ADMIN_HUB_ROWS) {
    assert.ok(row.label && row.label.length > 0, `${row.id} needs a label`);
    assert.ok(row.desc && row.desc.length > 0, `${row.id} needs a description`);
    assert.ok(row.route.startsWith("#/admin"), `${row.id} route must stay under #/admin so the Admin tab stays active`);
  }
});

test("the hub-row model is frozen (a shared constant callers must not mutate)", () => {
  assert.ok(Object.isFrozen(ADMIN_HUB_ROWS));
  assert.ok(ADMIN_HUB_ROWS.every((r) => Object.isFrozen(r)));
});
