// Unit tests for the Event group chat pure core (TM-515 / TM-433) — the read-receipt ladder + the
// seed conversations / thread lookup.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, so it runs in plain
// Node exactly like tabbar-core.test.mjs / components-core.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REACTION_EMOJIS,
  receiptState,
  listConversations,
  getConversation,
  threadMessages,
  hasMessages,
  totalUnread,
} from "../src/assets/chat-core.js";

test("receiptState is the TM-433 delivery ladder: sent / read (some) / group (all)", () => {
  // Read by nobody → one tick (delivered, unread).
  assert.equal(receiptState(0, 12), "sent");
  // Read by at least one but not all → two ticks.
  assert.equal(receiptState(1, 12), "read");
  assert.equal(receiptState(7, 12), "read");
  assert.equal(receiptState(11, 12), "read");
  // Read by everyone → three ticks (whole-group-read).
  assert.equal(receiptState(12, 12), "group");
  // Over-count (defensive) still reads as whole-group-read, never a fourth state.
  assert.equal(receiptState(20, 12), "group");
});

test("receiptState is defensive about bad / degenerate inputs", () => {
  // A 0-member group can't make an unread message "group" (members clamps to >= 1).
  assert.equal(receiptState(0, 0), "sent");
  // Non-numeric / negative inputs coerce to 0 read → "sent" (never throws).
  assert.equal(receiptState(NaN, 12), "sent");
  assert.equal(receiptState(-3, 12), "sent");
});

test("threadMessages tags every OUT-going message with its derived receipt (all three states appear)", () => {
  const msgs = threadMessages("sunday-dog-walk");
  const out = msgs.filter((m) => m.from === "me");
  // The seed thread demonstrates the FULL ladder for the TM-511 triple-tick component.
  assert.deepEqual(
    out.map((m) => m.receipt),
    ["group", "read", "sent"],
  );
  // Incoming messages never carry a receipt (only the sender sees their own ticks).
  for (const m of msgs.filter((m) => m.from === "them")) {
    assert.equal(m.receipt, undefined);
  }
});

test("threadMessages is a copy — it never mutates the seed (idempotent across calls)", () => {
  const a = threadMessages("sunday-dog-walk");
  const b = threadMessages("sunday-dog-walk");
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(
    a.map((m) => m.text),
    b.map((m) => m.text),
  );
});

test("the empty conversation has no messages (drives the paper-chat-empty state)", () => {
  assert.equal(hasMessages("park-picnic"), false);
  assert.deepEqual(threadMessages("park-picnic"), []);
  assert.equal(hasMessages("sunday-dog-walk"), true);
});

test("getConversation returns a known conversation and null for anything else", () => {
  assert.equal(getConversation("coffee-code").name, "Coffee & Code");
  assert.equal(getConversation("does-not-exist"), null);
  assert.equal(getConversation(""), null);
  assert.equal(getConversation(undefined), null);
});

test("the chat list matches the wireframe: order, avatars, unread badges and self-preview ticks", () => {
  const list = listConversations();
  assert.deepEqual(
    list.map((c) => c.id),
    ["sunday-dog-walk", "coffee-code", "bouldering-social", "marhaba-team", "park-picnic"],
  );
  // Unread badges are shown only where the wireframe shows them (2 and 5).
  assert.deepEqual(
    list.map((c) => c.unread),
    [2, 0, 5, 0, 0],
  );
  // A self ("You: …") preview carries a tick; an incoming preview does not.
  const coffee = getConversation("coffee-code");
  assert.equal(coffee.preview.self, true);
  assert.equal(coffee.preview.receipt, "read"); // ✓✓ in the wireframe
  const team = getConversation("marhaba-team");
  assert.equal(team.preview.receipt, "sent"); // ✓ in the wireframe
  const dog = getConversation("sunday-dog-walk");
  assert.equal(dog.preview.self, false);
  assert.equal(dog.preview.receipt, null);
});

test("the reaction picker offers the wireframe's five emoji", () => {
  assert.deepEqual([...REACTION_EMOJIS], ["👍", "❤️", "😂", "🎉", "🙌"]);
});

test("totalUnread sums the per-conversation unread counts", () => {
  // 2 (dog walk) + 5 (bouldering) = 7.
  assert.equal(totalUnread(), 7);
});
