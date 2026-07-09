// Unit tests (TM-443) for the pure admin compose route helpers — the full-page compose form's routing
// math, asserted without a browser (the admin-event-route split). Runs on the PR gate via
// `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_MESSAGES_ROUTE,
  ADMIN_MESSAGE_NEW_ROUTE,
  adminMessageNewHash,
  isAdminMessageComposeRoute,
} from "../src/assets/admin-message-route.js";

test("the route constants are the expected hashes", () => {
  assert.equal(ADMIN_MESSAGES_ROUTE, "#/admin/messages");
  assert.equal(ADMIN_MESSAGE_NEW_ROUTE, "#/admin/messages/new");
});

test("new-hash builder points at the compose route", () => {
  assert.equal(adminMessageNewHash(), "#/admin/messages/new");
  assert.equal(adminMessageNewHash(), ADMIN_MESSAGE_NEW_ROUTE);
});

test("the compose route IS a compose route", () => {
  assert.equal(isAdminMessageComposeRoute("#/admin/messages/new"), true);
  assert.equal(isAdminMessageComposeRoute(ADMIN_MESSAGE_NEW_ROUTE), true);
});

test("the bare list route is NOT a compose route (owned by TM-444)", () => {
  assert.equal(isAdminMessageComposeRoute(ADMIN_MESSAGES_ROUTE), false);
  assert.equal(isAdminMessageComposeRoute("#/admin/messages"), false);
});

test("unrelated / malformed hashes are not compose routes", () => {
  for (const h of [
    "#/admin",
    "#/admin/events/new",
    "#/home",
    "#/admin/messages/new/extra",
    "#/admin/messages/",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isAdminMessageComposeRoute(h), false, `expected non-compose: ${String(h)}`);
  }
});
