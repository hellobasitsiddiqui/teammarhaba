// Unit tests for the admin hub's pure route model (TM-917 / TM-972) — routes + the hub-row set/order,
// and the two new lift-and-shift routes (Send notification / Developer tools).
// Framework-free (node:test), picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_HUB_ROUTE,
  ADMIN_USERS_ROUTE,
  ADMIN_NOTIFICATIONS_ROUTE,
  ADMIN_OPS_ROUTE,
  ADMIN_HUB_ROWS,
  isAdminNotificationsRoute,
  isAdminOpsRoute,
} from "../src/assets/admin-hub-route.js";

test("the hub is #/admin and the users console moved to #/admin/users (TM-917)", () => {
  assert.equal(ADMIN_HUB_ROUTE, "#/admin");
  assert.equal(ADMIN_USERS_ROUTE, "#/admin/users");
});

test("the two lifted routes have their own stable #/admin* hashes (TM-972)", () => {
  assert.equal(ADMIN_NOTIFICATIONS_ROUTE, "#/admin/notifications");
  assert.equal(ADMIN_OPS_ROUTE, "#/admin/ops");
});

test("the hub lists the verb-led folds in order, each with a stable #/admin* route (TM-972; +cities TM-1166)", () => {
  assert.deepEqual(
    ADMIN_HUB_ROWS.map((r) => r.id),
    ["users", "events", "venues", "interests", "cities", "messages", "notifications", "ops"],
  );
  assert.deepEqual(
    ADMIN_HUB_ROWS.map((r) => r.route),
    [
      "#/admin/users",
      "#/admin/events",
      "#/admin/venues",
      "#/admin/interests",
      "#/admin/cities",
      "#/admin/messages",
      "#/admin/notifications",
      "#/admin/ops",
    ],
  );
  assert.deepEqual(
    ADMIN_HUB_ROWS.map((r) => r.label),
    [
      "Manage users",
      "Manage events",
      "Manage venues",
      "Manage interests",
      "Manage cities",
      "Send a message",
      "Send notification",
      "Developer tools",
    ],
  );
  // The first row is the moved users console (its route equals ADMIN_USERS_ROUTE).
  assert.equal(ADMIN_HUB_ROWS[0].route, ADMIN_USERS_ROUTE);
  // The two new folds address the two new lift-and-shift routes.
  assert.equal(ADMIN_HUB_ROWS.find((r) => r.id === "notifications").route, ADMIN_NOTIFICATIONS_ROUTE);
  assert.equal(ADMIN_HUB_ROWS.find((r) => r.id === "ops").route, ADMIN_OPS_ROUTE);
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

test("the two new route predicates match ONLY their exact hash (TM-972)", () => {
  assert.ok(isAdminNotificationsRoute("#/admin/notifications"));
  assert.ok(!isAdminNotificationsRoute("#/admin/notifications/x"));
  assert.ok(!isAdminNotificationsRoute("#/admin/ops"));
  assert.ok(!isAdminNotificationsRoute("#/admin"));

  assert.ok(isAdminOpsRoute("#/admin/ops"));
  assert.ok(!isAdminOpsRoute("#/admin/ops/x"));
  assert.ok(!isAdminOpsRoute("#/admin/notifications"));
  assert.ok(!isAdminOpsRoute("#/admin"));
});
