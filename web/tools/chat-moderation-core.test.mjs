// Unit tests for the Chat moderation pure core (TM-449) — the app-admin thread-moderation client
// contract: the mute options, the endpoint path builders, the request body + validation, the admin
// affordance gate, and the failure classification.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, so it runs in plain
// Node exactly like chat-core.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MODERATION_MUTE_OPTIONS,
  canModerate,
  removeMessagePath,
  muteMemberPath,
  muteRequestBody,
  classifyModerationError,
} from "../src/assets/chat-moderation-core.js";

test("MODERATION_MUTE_OPTIONS offers exactly the three backend states, escalation-ordered", () => {
  assert.deepEqual(
    MODERATION_MUTE_OPTIONS.map((o) => o.value),
    ["READ_ONLY", "REMOVED", "NONE"],
  );
  // Every option carries UI copy so a consumer can render it straight from the source.
  for (const o of MODERATION_MUTE_OPTIONS) {
    assert.ok(o.label && typeof o.label === "string");
    assert.ok(o.description && typeof o.description === "string");
  }
  // Frozen — a consumer can't accidentally mutate the shared source of truth.
  assert.ok(Object.isFrozen(MODERATION_MUTE_OPTIONS));
  assert.throws(() => MODERATION_MUTE_OPTIONS.push({}), TypeError);
});

test("canModerate is true only for an ADMIN role (string or object), case-insensitively", () => {
  assert.equal(canModerate("ADMIN"), true);
  assert.equal(canModerate("admin"), true);
  assert.equal(canModerate({ role: "ADMIN" }), true);
  assert.equal(canModerate("USER"), false);
  assert.equal(canModerate({ role: "USER" }), false);
  // Missing / malformed input never shows the control (fails safe).
  assert.equal(canModerate(undefined), false);
  assert.equal(canModerate(null), false);
  assert.equal(canModerate({}), false);
  assert.equal(canModerate(""), false);
});

test("path builders match the openapi contract and encode ids", () => {
  assert.equal(
    removeMessagePath(42, 7),
    "/api/v1/admin/conversations/42/messages/7/remove",
  );
  assert.equal(muteMemberPath(42, 9), "/api/v1/admin/conversations/42/members/9/mute");
  // String ids work too, and anything odd is URL-encoded rather than breaking the path.
  assert.equal(muteMemberPath("4 2", "a/b"), "/api/v1/admin/conversations/4%202/members/a%2Fb/mute");
});

test("muteRequestBody validates the state and returns the wire body", () => {
  assert.deepEqual(muteRequestBody("READ_ONLY"), { state: "READ_ONLY" });
  assert.deepEqual(muteRequestBody("REMOVED"), { state: "REMOVED" });
  assert.deepEqual(muteRequestBody("NONE"), { state: "NONE" });
  // An unknown state is a call-site bug — thrown before it can hit the network.
  assert.throws(() => muteRequestBody("BANHAMMER"), /Unknown mute state/);
  assert.throws(() => muteRequestBody(undefined), /Unknown mute state/);
});

test("classifyModerationError maps status → UI outcome", () => {
  // 401 / 403 → not permitted, control shouldn't have shown.
  for (const status of [401, 403]) {
    const out = classifyModerationError({ status, message: "You do not have permission." });
    assert.equal(out.permitted, false);
    assert.equal(out.transient, false);
    assert.equal(out.reasonKey, "forbidden");
    assert.equal(out.message, "You do not have permission.");
  }
  // 404 → gone / stale view (still permitted to moderate, just nothing there) → refresh.
  const gone = classifyModerationError({ status: 404 });
  assert.equal(gone.permitted, true);
  assert.equal(gone.transient, false);
  assert.equal(gone.reasonKey, "gone");
  assert.ok(gone.message.length > 0);
  // 5xx / network → transient, retryable.
  const boom = classifyModerationError({ status: 500 });
  assert.equal(boom.transient, true);
  assert.equal(boom.reasonKey, "transient");
  const offline = classifyModerationError({});
  assert.equal(offline.transient, true);
});
