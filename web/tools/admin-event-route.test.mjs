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
  adminEventRosterHash,
  isAdminEventFormRoute,
  parseAdminEventFormRoute,
  isAdminEventRosterRoute,
  parseAdminEventRosterRoute,
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

// ---- roster route (TM-1115) --------------------------------------------------------------------

test("roster-hash builder embeds and percent-encodes the id", () => {
  assert.equal(adminEventRosterHash(42), "#/admin/events/42/roster");
  assert.equal(adminEventRosterHash("abc"), "#/admin/events/abc/roster");
  assert.equal(adminEventRosterHash("a b"), "#/admin/events/a%20b/roster");
});

test("parse recognises a roster route and decodes the id", () => {
  assert.deepEqual(parseAdminEventRosterRoute("#/admin/events/42/roster"), { id: "42" });
  assert.deepEqual(parseAdminEventRosterRoute("#/admin/events/a%20b/roster"), { id: "a b" });
  assert.equal(isAdminEventRosterRoute("#/admin/events/99/roster"), true);
});

test("roster hash round-trips through parse", () => {
  assert.deepEqual(parseAdminEventRosterRoute(adminEventRosterHash("evt-77")), { id: "evt-77" });
});

// ⚠ The single biggest parse-order risk: /edit and /roster must NEVER swallow each other. Each parser
// fires ONLY on its own suffix — assert BOTH directions so the more-specific suffix is never eaten.
test("edit and roster routes never cross-match (parse-order)", () => {
  const editHash = "#/admin/events/42/edit";
  const rosterHash = "#/admin/events/42/roster";

  // The edit parser rejects a roster hash…
  assert.equal(isAdminEventFormRoute(rosterHash), false);
  assert.equal(parseAdminEventFormRoute(rosterHash), null);
  // …and the roster parser rejects an edit hash.
  assert.equal(isAdminEventRosterRoute(editHash), false);
  assert.equal(parseAdminEventRosterRoute(editHash), null);

  // Each fires only on its own suffix.
  assert.deepEqual(parseAdminEventFormRoute(editHash), { mode: "edit", id: "42" });
  assert.deepEqual(parseAdminEventRosterRoute(rosterHash), { id: "42" });

  // The create route is neither an edit-with-id nor a roster route.
  assert.equal(isAdminEventRosterRoute("#/admin/events/new"), false);
});

test("bare list route + unrelated / malformed hashes are not roster routes", () => {
  for (const h of [
    ADMIN_EVENTS_ROUTE,
    "#/admin/events",
    "#/admin/events/new",
    "#/admin",
    "#/home",
    "#/events/42/roster", // user events area, not admin
    "#/admin/events/", // no id + no suffix
    "#/admin/events//roster", // empty id
    "#/admin/events/a/b/roster", // nested id
    "#/admin/events/%/roster", // bad percent-escape
    "",
    null,
    undefined,
  ]) {
    assert.equal(isAdminEventRosterRoute(h), false, `expected non-roster: ${String(h)}`);
    assert.equal(parseAdminEventRosterRoute(h), null, `expected null parse: ${String(h)}`);
  }
});
