// Unit tests (TM-1166) for the pure admin city-form route helpers — the full-page create/edit form's
// routing math, asserted without a browser (mirrors admin-venues-route.test.mjs). Runs on the PR gate
// via `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_CITIES_ROUTE,
  ADMIN_CITY_NEW_ROUTE,
  adminCityNewHash,
  adminCityEditHash,
  isAdminCityFormRoute,
  parseAdminCityFormRoute,
} from "../src/assets/admin-cities-route.js";

test("route constants are the #/admin/cities family", () => {
  assert.equal(ADMIN_CITIES_ROUTE, "#/admin/cities");
  assert.equal(ADMIN_CITY_NEW_ROUTE, "#/admin/cities/new");
});

test("new-hash builder points at the create route", () => {
  assert.equal(adminCityNewHash(), "#/admin/cities/new");
  assert.equal(adminCityNewHash(), ADMIN_CITY_NEW_ROUTE);
});

test("edit-hash builder embeds and percent-encodes the id", () => {
  assert.equal(adminCityEditHash(42), "#/admin/cities/42/edit");
  assert.equal(adminCityEditHash("abc"), "#/admin/cities/abc/edit");
  assert.equal(adminCityEditHash("a b"), "#/admin/cities/a%20b/edit");
});

test("parse recognises the create route", () => {
  assert.deepEqual(parseAdminCityFormRoute("#/admin/cities/new"), { mode: "create", id: null });
  assert.equal(isAdminCityFormRoute("#/admin/cities/new"), true);
});

test("parse recognises an edit route and decodes the id", () => {
  assert.deepEqual(parseAdminCityFormRoute("#/admin/cities/7/edit"), { mode: "edit", id: "7" });
  assert.deepEqual(parseAdminCityFormRoute("#/admin/cities/a%20b/edit"), { mode: "edit", id: "a b" });
  assert.equal(isAdminCityFormRoute("#/admin/cities/7/edit"), true);
});

test("the bare list route is NOT a form route", () => {
  assert.equal(parseAdminCityFormRoute("#/admin/cities"), null);
  assert.equal(isAdminCityFormRoute("#/admin/cities"), false);
});

test("malformed hashes return null", () => {
  assert.equal(parseAdminCityFormRoute("#/admin/cities//edit"), null); // empty id
  assert.equal(parseAdminCityFormRoute("#/admin/cities/a/b/edit"), null); // nested slashes
  assert.equal(parseAdminCityFormRoute("#/admin/cities/%E0%A4%A/edit"), null); // bad percent-escape
  assert.equal(parseAdminCityFormRoute("#/admin/venues/7/edit"), null); // different console
  assert.equal(parseAdminCityFormRoute(null), null);
  assert.equal(parseAdminCityFormRoute(undefined), null);
});
