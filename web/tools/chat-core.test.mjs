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
  ADMIN_AUTHOR,
  deepLinkCta,
  toThreadMessage,
  toThreadMessages,
  MAX_MESSAGE_LENGTH,
  validateDraft,
  composeAvailability,
  classifyPostError,
  pendingMessage,
  upsertMessage,
  threadSignature,
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

/* ─────────────────────────────── one-way admin messages (TM-445) ──────────────────────────────── */

test("ADMIN_AUTHOR is the app attribution name for a one-way system message", () => {
  assert.equal(ADMIN_AUTHOR, "TeamMarhaba");
});

test("deepLinkCta labels each safe in-app route family and coerces loose shapes", () => {
  // Detail routes get a purpose-fit label; the id segment's case is preserved.
  assert.deepEqual(deepLinkCta("#/events/42"), { href: "#/events/42", label: "View event" });
  assert.deepEqual(deepLinkCta("/events/42"), { href: "#/events/42", label: "View event" });
  assert.deepEqual(deepLinkCta("events/42"), { href: "#/events/42", label: "View event" });
  assert.deepEqual(deepLinkCta("#/chat/7"), { href: "#/chat/7", label: "Open chat" });
  // The events list gets its own label; any other known static route falls back to a neutral "Open".
  assert.deepEqual(deepLinkCta("/events"), { href: "#/events", label: "Browse events" });
  assert.deepEqual(deepLinkCta("/home"), { href: "#/home", label: "Open" });
  assert.deepEqual(deepLinkCta("#/profile"), { href: "#/profile", label: "Open" });
});

test("deepLinkCta drops unsafe / off-app / unknown links so a bad CTA is never drawn", () => {
  for (const bad of [
    "https://evil.example/steal",
    "http://x",
    "javascript:alert(1)", // eslint-disable-line no-script-url
    "//evil.example",
    "/nope/xyz", // a known-shape but unknown base → rejected by the trust boundary
    "",
    "   ",
    null,
    undefined,
    42,
  ]) {
    assert.equal(deepLinkCta(bad), null, `"${String(bad)}" must not produce a CTA`);
  }
});

test("toThreadMessage pre-derives the CTA from a safe deep-link (admin broadcast render)", () => {
  const admin = toThreadMessage({ id: 5, senderId: null, system: true, body: "Doors open at 6pm", deepLink: "/events/9" });
  assert.equal(admin.system, true);
  assert.equal(admin.deepLink, "/events/9"); // raw link carried as-sent (un-normalised)
  assert.deepEqual(admin.cta, { href: "#/events/9", label: "View event" }); // …but the CTA is the safe route
});

test("toThreadMessage: no deep-link → no CTA, and an unsafe deep-link → no CTA (raw link still carried)", () => {
  assert.equal(toThreadMessage({ id: 1, system: true, body: "Welcome!" }).cta, null);
  const unsafe = toThreadMessage({ id: 2, system: true, body: "Visit us", deepLink: "https://evil.example" });
  assert.equal(unsafe.cta, null); // dropped by the trust boundary → CTA not drawn
  assert.equal(unsafe.deepLink, "https://evil.example"); // raw value preserved, just not made tappable
});

test("pendingMessage carries a null cta so the optimistic echo shares the render shape", () => {
  assert.equal(pendingMessage("hi", { localId: "p1" }).cta, null);
});

/* ─────────────────────────────── composer: draft validation (TM-448) ──────────────────────────── */

test("validateDraft: non-blank + ≤500 is sendable; trims; reports length / remaining", () => {
  const ok = validateDraft("  hello  ");
  assert.equal(ok.value, "hello"); // trimmed for the wire
  assert.equal(ok.length, 5);
  assert.equal(ok.remaining, MAX_MESSAGE_LENGTH - 5);
  assert.equal(ok.canSend, true);
  assert.equal(ok.empty, false);
  assert.equal(ok.tooLong, false);
});

test("validateDraft: blank / whitespace-only is not sendable", () => {
  for (const bad of ["", "   ", "\n\t", null, undefined]) {
    const v = validateDraft(bad);
    assert.equal(v.canSend, false, `"${bad}" should not send`);
    assert.equal(v.empty, true);
  }
});

test("validateDraft: >500 chars is too long and not sendable (boundary is inclusive at 500)", () => {
  const at = validateDraft("x".repeat(MAX_MESSAGE_LENGTH));
  assert.equal(at.canSend, true);
  assert.equal(at.remaining, 0);
  const over = validateDraft("x".repeat(MAX_MESSAGE_LENGTH + 1));
  assert.equal(over.tooLong, true);
  assert.equal(over.canSend, false);
  assert.equal(over.remaining, -1);
});

/* ─────────────────────────────── composer: up-front availability (TM-448) ─────────────────────── */

test("composeAvailability: admin broadcasts are read-only up-front; event chats are open", () => {
  // Raw backend type…
  assert.equal(composeAvailability({ type: "ADMIN_BROADCAST" }).canPost, false);
  assert.match(composeAvailability({ type: "ADMIN_BROADCAST" }).reason, /admin/i);
  assert.equal(composeAvailability({ type: "EVENT_GROUP" }).canPost, true);
  assert.equal(composeAvailability({ type: "EVENT_GROUP" }).reason, null);
  // …and an already-mapped row shape ({ type: { key } }).
  assert.equal(composeAvailability({ type: { key: "admin" } }).canPost, false);
  assert.equal(composeAvailability({ type: { key: "event" } }).canPost, true);
  // Unknown / missing type defaults to open (attempt-and-see, like the badge default).
  assert.equal(composeAvailability({}).canPost, true);
  assert.equal(composeAvailability(null).canPost, true);
});

/* ─────────────────────────────── composer: post-error classification (TM-448) ─────────────────── */

test("classifyPostError: 403 muted → lock with the muted reason", () => {
  const out = classifyPostError({ status: 403, message: "You are muted in this thread and cannot post." });
  assert.equal(out.locked, true);
  assert.equal(out.transient, false);
  assert.equal(out.reasonKey, "muted");
  assert.match(out.reason, /muted/i);
});

test("classifyPostError: 403 not-a-member/removed → lock as removed", () => {
  const out = classifyPostError({ status: 403, message: "You are not a member of this thread." });
  assert.equal(out.locked, true);
  assert.equal(out.reasonKey, "removed");
  assert.match(out.reason, /not a member/i);
});

test("classifyPostError: 409 closed thread → lock as closed", () => {
  const out = classifyPostError({ status: 409, message: "This thread is closed; you can no longer post." });
  assert.equal(out.locked, true);
  assert.equal(out.reasonKey, "closed");
  assert.match(out.reason, /closed/i);
});

test("classifyPostError: 404 → lock, gone (friendly, ignores the technical body)", () => {
  const out = classifyPostError({ status: 404, message: "conversation 9 not found" });
  assert.equal(out.locked, true);
  assert.equal(out.reasonKey, "gone");
  assert.match(out.reason, /no longer available/i);
});

test("classifyPostError: 400 validation → surface inline, do NOT lock", () => {
  const out = classifyPostError({ status: 400, message: "body must not be blank" });
  assert.equal(out.locked, false);
  assert.equal(out.transient, false);
  assert.equal(out.reasonKey, "invalid");
});

test("classifyPostError: 5xx / network / unknown → transient, keep composing", () => {
  for (const err of [{ status: 500 }, { status: 503, message: "upstream" }, {}, null]) {
    const out = classifyPostError(err);
    assert.equal(out.locked, false, JSON.stringify(err));
    assert.equal(out.transient, true);
    assert.equal(out.reasonKey, "transient");
    assert.match(out.message, /try again/i);
  }
});

/* ─────────────────────────────── composer: optimistic echo + refresh maths (TM-448) ───────────── */

test("pendingMessage: a toThreadMessage-shaped echo flagged pending, at the given local id", () => {
  const now = new Date(2026, 6, 9, 14, 5, 0);
  const p = pendingMessage("  see you there  ", { localId: "pending-1", now });
  assert.equal(p.id, "pending-1");
  assert.equal(p.body, "  see you there  "); // body kept verbatim (chat.js sends the trimmed value)
  assert.equal(p.pending, true);
  assert.equal(p.system, false);
  assert.deepEqual(p.reactions, []);
  assert.equal(p.timeLabel, "14:05"); // formatted like a real message
  assert.equal(p.sortAt, now.getTime()); // sorts after all loaded messages
});

test("upsertMessage: inserts by sortAt order and replaces (never duplicates) by id", () => {
  const base = [
    { id: "1", sortAt: 100 },
    { id: "2", sortAt: 200 },
  ];
  const appended = upsertMessage(base, { id: "3", sortAt: 300 });
  assert.deepEqual(appended.map((m) => m.id), ["1", "2", "3"]);
  assert.deepEqual(base.map((m) => m.id), ["1", "2"]); // input not mutated
  // A middle insert lands in order.
  assert.deepEqual(upsertMessage(base, { id: "9", sortAt: 150 }).map((m) => m.id), ["1", "9", "2"]);
  // Same id replaces in place (idempotent poll / confirm).
  const replaced = upsertMessage(base, { id: "2", sortAt: 200, body: "edited" });
  assert.equal(replaced.length, 2);
  assert.equal(replaced.find((m) => m.id === "2").body, "edited");
});

test("threadSignature: changes when a message is appended, stable otherwise", () => {
  const a = [{ id: "1", sortAt: 100 }, { id: "2", sortAt: 200 }];
  const same = [{ id: "1", sortAt: 100 }, { id: "2", sortAt: 200 }];
  const grown = [...a, { id: "3", sortAt: 300 }];
  assert.equal(threadSignature(a), threadSignature(same)); // unchanged → poll won't repaint
  assert.notEqual(threadSignature(a), threadSignature(grown)); // appended → repaint
  assert.equal(threadSignature([]), "0");
  assert.equal(threadSignature(null), "0");
});
