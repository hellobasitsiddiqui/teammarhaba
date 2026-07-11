// Unit tests (TM-519) for the pure admin venue-form route helpers — the full-page create/edit form's
// routing math, asserted without a browser (mirrors admin-event-route.test.mjs). Runs on the PR gate
// via `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_VENUES_ROUTE,
  ADMIN_VENUE_NEW_ROUTE,
  adminVenueNewHash,
  adminVenueEditHash,
  isAdminVenueFormRoute,
  parseAdminVenueFormRoute,
} from "../src/assets/admin-venues-route.js";

test("new-hash builder points at the create route", () => {
  assert.equal(adminVenueNewHash(), "#/admin/venues/new");
  assert.equal(adminVenueNewHash(), ADMIN_VENUE_NEW_ROUTE);
});

test("edit-hash builder embeds and percent-encodes the id", () => {
  assert.equal(adminVenueEditHash(42), "#/admin/venues/42/edit");
  assert.equal(adminVenueEditHash("abc"), "#/admin/venues/abc/edit");
  assert.equal(adminVenueEditHash("a b"), "#/admin/venues/a%20b/edit");
});

test("parse recognises the create route", () => {
  assert.deepEqual(parseAdminVenueFormRoute("#/admin/venues/new"), { mode: "create", id: null });
  assert.equal(isAdminVenueFormRoute("#/admin/venues/new"), true);
});

test("parse recognises an edit route and decodes the id", () => {
  assert.deepEqual(parseAdminVenueFormRoute("#/admin/venues/42/edit"), { mode: "edit", id: "42" });
  assert.deepEqual(parseAdminVenueFormRoute("#/admin/venues/a%20b/edit"), { mode: "edit", id: "a b" });
  assert.equal(isAdminVenueFormRoute("#/admin/venues/42/edit"), true);
});

test("the bare list route and malformed hashes are not form routes", () => {
  assert.equal(parseAdminVenueFormRoute(ADMIN_VENUES_ROUTE), null);
  assert.equal(parseAdminVenueFormRoute("#/admin/venues"), null);
  assert.equal(parseAdminVenueFormRoute("#/admin/venues//edit"), null); // empty id
  assert.equal(parseAdminVenueFormRoute("#/admin/venues/a/b/edit"), null); // nested slashes
  assert.equal(parseAdminVenueFormRoute("#/admin/events/new"), null); // a different area
  assert.equal(parseAdminVenueFormRoute(null), null);
  assert.equal(isAdminVenueFormRoute("#/admin/venues"), false);
});
