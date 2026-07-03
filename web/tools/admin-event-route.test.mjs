// Unit tests (TM-426) for the pure admin event-form route helpers — the full-page create/edit form's
// routing math, asserted without a browser (the auth-env / event-form split). Runs on the PR gate via
// `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_EVENTS_ROUTE,
  ADMIN_EVENT_NEW_ROUTE,
  adminEventNewHash,
  adminEventEditHash,
  isAdminEventFormRoute,
  parseAdminEventFormRoute,
} from "../src/assets/admin-event-route.js";

test("new-hash builder points at the create route", () => {
  assert.equal(adminEventNewHash(), "#/admin/events/new");
  assert.equal(adminEventNewHash(), ADMIN_EVENT_NEW_ROUTE);
});

test("edit-hash builder embeds and percent-encodes the id", () => {
  assert.equal(adminEventEditHash(42), "#/admin/events/42/edit");
  assert.equal(adminEventEditHash("abc"), "#/admin/events/abc/edit");
  // A non-UUID id with a space stays a single safe segment.
  assert.equal(adminEventEditHash("a b"), "#/admin/events/a%20b/edit");
});

test("parse recognises the create route", () => {
  assert.deepEqual(parseAdminEventFormRoute("#/admin/events/new"), { mode: "create", id: null });
  assert.equal(isAdminEventFormRoute("#/admin/events/new"), true);
});

test("parse recognises an edit route and decodes the id", () => {
  assert.deepEqual(parseAdminEventFormRoute("#/admin/events/42/edit"), { mode: "edit", id: "42" });
  assert.deepEqual(parseAdminEventFormRoute("#/admin/events/a%20b/edit"), { mode: "edit", id: "a b" });
  assert.equal(isAdminEventFormRoute("#/admin/events/99/edit"), true);
});

test("edit hash round-trips through parse", () => {
  assert.deepEqual(parseAdminEventFormRoute(adminEventEditHash("evt-77")), { mode: "edit", id: "evt-77" });
});

test("the bare list route is NOT a form route", () => {
  assert.equal(parseAdminEventFormRoute(ADMIN_EVENTS_ROUTE), null);
  assert.equal(isAdminEventFormRoute(ADMIN_EVENTS_ROUTE), false);
  assert.equal(isAdminEventFormRoute("#/admin/events"), false);
});

test("unrelated / malformed hashes are not form routes", () => {
  for (const h of [
    "#/admin",
    "#/home",
    "#/events/42",
    "#/admin/events/",
    "#/admin/events//edit",
    "#/admin/events/a/b/edit",
    "#/admin/events/%/edit", // bad percent-escape
    "",
    null,
    undefined,
  ]) {
    assert.equal(isAdminEventFormRoute(h), false, `expected non-form: ${String(h)}`);
    assert.equal(parseAdminEventFormRoute(h), null, `expected null parse: ${String(h)}`);
  }
});
