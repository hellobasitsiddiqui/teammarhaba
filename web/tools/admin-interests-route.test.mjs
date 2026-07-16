// Unit tests (TM-779) for the pure admin interest-form route helpers — the full-page create/edit form's
// routing math, asserted without a browser (mirrors admin-venues-route.test.mjs). Runs on the PR gate
// via `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_INTERESTS_ROUTE,
  ADMIN_INTEREST_NEW_ROUTE,
  adminInterestNewHash,
  adminInterestEditHash,
  isAdminInterestFormRoute,
  parseAdminInterestFormRoute,
} from "../src/assets/admin-interests-route.js";

test("new-hash builder points at the create route", () => {
  assert.equal(adminInterestNewHash(), "#/admin/interests/new");
  assert.equal(adminInterestNewHash(), ADMIN_INTEREST_NEW_ROUTE);
});

test("edit-hash builder embeds and percent-encodes the id", () => {
  assert.equal(adminInterestEditHash(42), "#/admin/interests/42/edit");
  assert.equal(adminInterestEditHash("abc"), "#/admin/interests/abc/edit");
  assert.equal(adminInterestEditHash("a b"), "#/admin/interests/a%20b/edit");
});

test("parse recognises the create route", () => {
  assert.deepEqual(parseAdminInterestFormRoute("#/admin/interests/new"), { mode: "create", id: null });
  assert.equal(isAdminInterestFormRoute("#/admin/interests/new"), true);
});

test("parse recognises an edit route and decodes the id", () => {
  assert.deepEqual(parseAdminInterestFormRoute("#/admin/interests/42/edit"), { mode: "edit", id: "42" });
  assert.deepEqual(parseAdminInterestFormRoute("#/admin/interests/a%20b/edit"), { mode: "edit", id: "a b" });
  assert.equal(isAdminInterestFormRoute("#/admin/interests/42/edit"), true);
});

test("the bare list route and malformed hashes are not form routes", () => {
  assert.equal(parseAdminInterestFormRoute(ADMIN_INTERESTS_ROUTE), null);
  assert.equal(parseAdminInterestFormRoute("#/admin/interests"), null);
  assert.equal(parseAdminInterestFormRoute("#/admin/interests//edit"), null); // empty id
  assert.equal(parseAdminInterestFormRoute("#/admin/interests/a/b/edit"), null); // nested slashes
  assert.equal(parseAdminInterestFormRoute("#/admin/interests/%E0%A4%A/edit"), null); // bad percent-escape
  assert.equal(parseAdminInterestFormRoute("#/admin/venues/new"), null); // a different area
  assert.equal(parseAdminInterestFormRoute(null), null);
  assert.equal(isAdminInterestFormRoute("#/admin/interests"), false);
});
