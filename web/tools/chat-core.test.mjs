// Unit tests for the Chat pure core (TM-438) — the conversation-read-API (TM-436) adapters + the
// retained read-receipt / reaction utilities.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, so it runs in plain
// Node exactly like events-core.test.mjs / components-core.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REACTION_EMOJIS,
  pickReaction,
  receiptState,
  conversationBadge,
  avatarGlyph,
  formatTimeLabel,
  toConversationRow,
  sortConversations,
  toConversationRows,
  totalUnread,
  toThreadMessage,
  toThreadMessages,
} from "../src/assets/chat-core.js";

/* ─────────────────────────────── retained pure utilities ──────────────────────────────────────── */

test("receiptState is the delivery ladder: sent / read (some) / group (all)", () => {
  assert.equal(receiptState(0, 12), "sent");
  assert.equal(receiptState(1, 12), "read");
  assert.equal(receiptState(11, 12), "read");
  assert.equal(receiptState(12, 12), "group");
  assert.equal(receiptState(20, 12), "group"); // over-count still whole-group-read
});

test("receiptState is defensive about bad / degenerate inputs", () => {
  assert.equal(receiptState(0, 0), "sent"); // members clamps to >= 1
  assert.equal(receiptState(NaN, 12), "sent");
  assert.equal(receiptState(-3, 12), "sent");
});

test("the reaction set + pickReaction produce a fresh single-select pill", () => {
  assert.deepEqual([...REACTION_EMOJIS], ["👍", "❤️", "😂", "🎉", "🙌"]);
  for (const emoji of REACTION_EMOJIS) assert.deepEqual(pickReaction(emoji), { emoji, count: 1 });
  assert.deepEqual(pickReaction(undefined), { emoji: "", count: 1 });
  assert.deepEqual(pickReaction(null), { emoji: "", count: 1 });
});

/* ─────────────────────────────── conversation type badge ──────────────────────────────────────── */

test("conversationBadge maps the two backend types, defaulting unknowns to Event", () => {
  assert.deepEqual(conversationBadge("EVENT_GROUP"), { key: "event", label: "Event" });
  assert.deepEqual(conversationBadge("ADMIN_BROADCAST"), { key: "admin", label: "Admin" });
  assert.deepEqual(conversationBadge(undefined), { key: "event", label: "Event" });
  assert.deepEqual(conversationBadge("SOMETHING_NEW"), { key: "event", label: "Event" });
});

test("avatarGlyph: megaphone for admin, title initial for events, glyph fallback", () => {
  assert.equal(avatarGlyph({ type: "ADMIN_BROADCAST", title: "Team news" }), "📣");
  assert.equal(avatarGlyph({ type: "EVENT_GROUP", title: "Sunday Dog Walk" }), "S");
  assert.equal(avatarGlyph({ type: "EVENT_GROUP", title: "" }), "💬");
  assert.equal(avatarGlyph({}), "💬");
});

/* ─────────────────────────────── time labels ──────────────────────────────────────────────────── */

test("formatTimeLabel: HH:MM today, D Mon this year, D Mon YYYY otherwise, '' for bad input", () => {
  // A fixed local "now" so the day/year branches are deterministic regardless of the runner's TZ.
  const now = new Date(2026, 6, 9, 12, 0, 0); // 9 Jul 2026, local
  // No-offset ISO date-times are parsed as LOCAL time, so these components are TZ-independent.
  assert.equal(formatTimeLabel("2026-07-09T14:05:00", now), "14:05"); // same calendar day
  assert.equal(formatTimeLabel("2026-07-09T09:03:00", now), "09:03"); // zero-padded
  assert.equal(formatTimeLabel("2026-07-03T09:30:00", now), "3 Jul"); // same year, earlier day
  assert.equal(formatTimeLabel("2025-12-25T10:00:00", now), "25 Dec 2025"); // prior year
  assert.equal(formatTimeLabel("", now), "");
  assert.equal(formatTimeLabel(null, now), "");
  assert.equal(formatTimeLabel("not-a-date", now), "");
});

/* ─────────────────────────────── conversation list adapters ───────────────────────────────────── */

const EVENT_SUMMARY = {
  id: 42,
  type: "EVENT_GROUP",
  title: "Sunday Dog Walk",
  eventId: 7,
  lastMessagePreview: "see you at the lake!",
  lastMessageAt: "2026-07-09T10:01:00",
  lastActiveAt: "2026-07-09T09:00:00",
  unreadCount: 3,
};

test("toConversationRow maps every field the row needs, and prefers lastMessageAt for the stamp", () => {
  const now = new Date(2026, 6, 9, 12, 0, 0);
  const row = toConversationRow(EVENT_SUMMARY, now);
  assert.equal(row.id, "42"); // stringified for the #/chat/{id} route
  assert.equal(row.title, "Sunday Dog Walk");
  assert.deepEqual(row.type, { key: "event", label: "Event" });
  assert.equal(row.preview, "see you at the lake!");
  assert.equal(row.unread, 3);
  assert.equal(row.avatar, "S");
  assert.equal(row.timeLabel, "10:01"); // lastMessageAt, not lastActiveAt
});

test("toConversationRow is defensive: blank title, clamped unread, empty preview, admin badge", () => {
  const row = toConversationRow({ id: 5, type: "ADMIN_BROADCAST", unreadCount: -4 });
  assert.equal(row.title, "Conversation");
  assert.equal(row.preview, "");
  assert.equal(row.unread, 0); // negative clamps to 0
  assert.deepEqual(row.type, { key: "admin", label: "Admin" });
  assert.equal(row.avatar, "📣");
});

test("toConversationRows unifies event + admin conversations newest-activity first", () => {
  const now = new Date(2026, 6, 9, 12, 0, 0);
  const items = [
    { id: 1, type: "EVENT_GROUP", title: "Older event", lastMessageAt: "2026-07-08T08:00:00", unreadCount: 0 },
    { id: 2, type: "ADMIN_BROADCAST", title: "Newest admin", lastMessageAt: "2026-07-09T11:00:00", unreadCount: 1 },
    { id: 3, type: "EVENT_GROUP", title: "Middle event", lastMessageAt: "2026-07-09T09:00:00", unreadCount: 0 },
  ];
  const rows = toConversationRows(items, now);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["2", "3", "1"], // interleaved by recency, admin + event together
  );
  assert.deepEqual(rows.map((r) => r.type.key), ["admin", "event", "event"]);
});

test("sortConversations / toConversationRows never mutate their input and tolerate junk", () => {
  const input = [{ sortAt: 1 }, { sortAt: 3 }, { sortAt: 2 }];
  const sorted = sortConversations(input);
  assert.deepEqual(sorted.map((r) => r.sortAt), [3, 2, 1]);
  assert.deepEqual(input.map((r) => r.sortAt), [1, 3, 2]); // input untouched
  assert.deepEqual(toConversationRows(null), []);
  assert.deepEqual(toConversationRows(undefined), []);
});

test("totalUnread sums unread across rows or raw summaries", () => {
  assert.equal(totalUnread([{ unread: 2 }, { unread: 5 }, { unread: 0 }]), 7);
  assert.equal(totalUnread([{ unreadCount: 3 }, { unreadCount: 4 }]), 7);
  assert.equal(totalUnread([]), 0);
  assert.equal(totalUnread(null), 0);
});

/* ─────────────────────────────── thread message adapters ──────────────────────────────────────── */

test("toThreadMessage maps body / system / reactions and normalises the reaction pills", () => {
  const now = new Date(2026, 6, 9, 12, 0, 0);
  const m = toThreadMessage(
    {
      id: 9,
      senderId: 100,
      body: "Morning!",
      createdAt: "2026-07-09T09:58:00",
      system: false,
      deepLink: "#/events/7",
      reactions: [
        { emoji: "👍", count: 3, mine: true },
        { emoji: "", count: 2 }, // dropped: no emoji
      ],
    },
    now,
  );
  assert.equal(m.id, "9");
  assert.equal(m.body, "Morning!");
  assert.equal(m.system, false);
  assert.equal(m.deepLink, "#/events/7");
  assert.equal(m.timeLabel, "09:58");
  assert.deepEqual(m.reactions, [{ emoji: "👍", count: 3, mine: true }]); // empty-emoji dropped
});

test("toThreadMessage flags system messages and defaults missing fields safely", () => {
  const m = toThreadMessage({ id: 1, system: true });
  assert.equal(m.system, true);
  assert.equal(m.body, "");
  assert.deepEqual(m.reactions, []);
  assert.equal(m.deepLink, null);
  assert.equal(m.timeLabel, "");
});

test("toThreadMessages orders oldest-first regardless of the server's page order", () => {
  const items = [
    { id: 3, body: "third", createdAt: "2026-07-09T10:03:00" },
    { id: 1, body: "first", createdAt: "2026-07-09T09:58:00" },
    { id: 2, body: "second", createdAt: "2026-07-09T10:01:00" },
  ];
  const ordered = toThreadMessages(items);
  assert.deepEqual(ordered.map((m) => m.body), ["first", "second", "third"]);
  assert.deepEqual(toThreadMessages(null), []);
});
