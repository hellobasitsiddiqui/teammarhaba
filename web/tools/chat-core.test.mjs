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
  normaliseReactions,
  applyReactionToggle,
  receiptState,
  conversationBadge,
  avatarGlyph,
  formatTimeLabel,
  toConversationRow,
  membershipControls,
  sortConversations,
  toConversationRows,
  ADMIN_AUTHOR,
  deepLinkCta,
  normaliseReceipt,
  readReceiptLabel,
  toThreadMessage,
  toThreadMessages,
  isAnnouncement,
  MAX_MESSAGE_LENGTH,
  validateDraft,
  composeAvailability,
  classifyPostError,
  pendingMessage,
  upsertMessage,
  mergeLiveMessage,
  threadSignature,
  createSseParser,
  parseSseFrame,
  MESSAGE_UNAVAILABLE,
  QUOTE_EXCERPT_MAX,
  quoteExcerpt,
  toQuotedPreview,
  replyTargetFrom,
  TYPING_DEBOUNCE_MS,
  TYPING_TTL_MS,
  typistName,
  shouldSignalTyping,
  applyTypingEvent,
  pruneTypists,
  typingLabel,
  EDIT_WINDOW_MS,
  EDITED_TAG,
  canEditWithinWindow,
  applyMessageEdit,
  removeMessageById,
  createAdminFlagCache,
} from "../src/assets/chat-core.js";
import { EVENT_CHAT_ENTRY_LABEL } from "../src/assets/events-core.js";

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
  // A "like" (👍) leads the picker so it's the prominent common reaction — no special like gesture.
  assert.equal(REACTION_EMOJIS[0], "👍");
  for (const emoji of REACTION_EMOJIS) assert.deepEqual(pickReaction(emoji), { emoji, count: 1 });
  assert.deepEqual(pickReaction(undefined), { emoji: "", count: 1 });
  assert.deepEqual(pickReaction(null), { emoji: "", count: 1 });
});

/* ─────────────────────────────── reactions: normalise + toggle (TM-462) ────────────────────────── */

test("normaliseReactions cleans chips: drops empty emoji, clamps count, coerces mine", () => {
  assert.deepEqual(
    normaliseReactions([
      { emoji: "👍", count: 3, mine: true },
      { emoji: "", count: 9 }, // dropped: no emoji
      { emoji: "🎉", count: -2, mine: 0 }, // count clamps to 0, mine coerces to false
      { emoji: "❤️", count: 1.9, mine: 1 }, // count truncates to 1, mine coerces to true
      null, // dropped: not an object
    ]),
    [
      { emoji: "👍", count: 3, mine: true },
      { emoji: "🎉", count: 0, mine: false },
      { emoji: "❤️", count: 1, mine: true },
    ],
  );
  assert.deepEqual(normaliseReactions(null), []);
  assert.deepEqual(normaliseReactions(undefined), []);
});

test("applyReactionToggle: a fresh emoji adds a mine chip and calls react (POST)", () => {
  const { reactions, action } = applyReactionToggle([], "👍");
  assert.equal(action, "react");
  assert.deepEqual(reactions, [{ emoji: "👍", count: 1, mine: true }]);
});

test("applyReactionToggle: reacting to an existing not-mine chip increments + flips mine (react)", () => {
  const { reactions, action } = applyReactionToggle(
    [{ emoji: "👍", count: 2, mine: false }, { emoji: "🎉", count: 1, mine: true }],
    "👍",
  );
  assert.equal(action, "react");
  // Only the tapped chip changes; the other (distinct) reaction is untouched (multi-select allowed).
  assert.deepEqual(reactions, [{ emoji: "👍", count: 3, mine: true }, { emoji: "🎉", count: 1, mine: true }]);
});

test("applyReactionToggle: un-reacting a mine chip decrements + flips mine (unreact)", () => {
  const { reactions, action } = applyReactionToggle([{ emoji: "👍", count: 3, mine: true }], "👍");
  assert.equal(action, "unreact");
  assert.deepEqual(reactions, [{ emoji: "👍", count: 2, mine: false }]);
});

test("applyReactionToggle: un-reacting the last count removes the chip entirely", () => {
  const { reactions, action } = applyReactionToggle(
    [{ emoji: "👍", count: 1, mine: true }, { emoji: "❤️", count: 4, mine: false }],
    "👍",
  );
  assert.equal(action, "unreact");
  assert.deepEqual(reactions, [{ emoji: "❤️", count: 4, mine: false }]); // 👍 gone, ❤️ untouched
});

test("applyReactionToggle: a blank glyph is a no-op (never creates an empty chip)", () => {
  const before = [{ emoji: "👍", count: 1, mine: true }];
  const { reactions, action } = applyReactionToggle(before, "");
  assert.equal(action, "react");
  assert.deepEqual(reactions, before);
});

test("applyReactionToggle does not mutate its input array or entries", () => {
  const before = [{ emoji: "👍", count: 2, mine: false }];
  const snapshot = JSON.parse(JSON.stringify(before));
  applyReactionToggle(before, "👍");
  assert.deepEqual(before, snapshot); // input untouched (pure)
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

test("toConversationRow carries the caller's self-service membership flags (TM-471)", () => {
  // Muted + left both surface (and default false when the backend omits them).
  const muted = toConversationRow({ id: 7, type: "EVENT_GROUP", notificationsMuted: true });
  assert.equal(muted.muted, true);
  assert.equal(muted.left, false);

  const left = toConversationRow({ id: 8, type: "EVENT_GROUP", left: true });
  assert.equal(left.left, true);
  assert.equal(left.muted, false);

  const plain = toConversationRow({ id: 9, type: "EVENT_GROUP" });
  assert.equal(plain.muted, false);
  assert.equal(plain.left, false);
});

test("membershipControls: picks the mute action/label and reflects the left state (TM-471)", () => {
  // Not muted → offer to mute; muted → offer to unmute.
  assert.deepEqual(membershipControls({ muted: false, left: false }), {
    muted: false,
    left: false,
    muteAction: "mute",
    muteLabel: "Mute notifications",
  });
  assert.deepEqual(membershipControls({ muted: true, left: false }), {
    muted: true,
    left: false,
    muteAction: "unmute",
    muteLabel: "Unmute notifications",
  });
  // The left flag is carried through, and a missing/empty argument defaults to the cold-deep-link case.
  assert.equal(membershipControls({ left: true }).left, true);
  assert.deepEqual(membershipControls(), {
    muted: false,
    left: false,
    muteAction: "mute",
    muteLabel: "Mute notifications",
  });
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

/* ─────────────────────────────── read receipts (TM-463) ───────────────────────────────────────── */

test("normaliseReceipt: null for a message with no receipt (not the caller's own)", () => {
  assert.equal(normaliseReceipt(undefined), null);
  assert.equal(normaliseReceipt(null), null);
  assert.equal(normaliseReceipt("nope"), null);
});

test("normaliseReceipt: keeps count + stringifies reader ids, and never drops below the ids held", () => {
  assert.deepEqual(normaliseReceipt({ count: 0, readerIds: [] }), { count: 0, readerIds: [] });
  assert.deepEqual(normaliseReceipt({ count: 2, readerIds: [7, 9] }), { count: 2, readerIds: ["7", "9"] });
  // count is clamped to >= the number of ids we actually have (defensive against a skewed payload).
  assert.deepEqual(normaliseReceipt({ count: 1, readerIds: [7, 9] }), { count: 2, readerIds: ["7", "9"] });
  // negative / junk count clamps to 0 (then to the id count).
  assert.deepEqual(normaliseReceipt({ count: -5, readerIds: [] }), { count: 0, readerIds: [] });
  assert.deepEqual(normaliseReceipt({ count: 3 }), { count: 3, readerIds: [] });
});

test("readReceiptLabel: 'Sent' at zero readers, 'Read by N' otherwise, '' with no receipt", () => {
  assert.equal(readReceiptLabel(null), "");
  assert.equal(readReceiptLabel({ count: 0, readerIds: [] }), "Sent");
  assert.equal(readReceiptLabel({ count: 1, readerIds: ["7"] }), "Read by 1");
  assert.equal(readReceiptLabel({ count: 3, readerIds: ["7", "9", "5"] }), "Read by 3");
});

test("toThreadMessage carries a normalised readReceipt for own messages, null otherwise", () => {
  const own = toThreadMessage({ id: 5, body: "mine", createdAt: "2026-07-09T09:00:00", readReceipt: { count: 2, readerIds: [7, 9] } });
  assert.deepEqual(own.readReceipt, { count: 2, readerIds: ["7", "9"] });
  const other = toThreadMessage({ id: 6, body: "theirs", createdAt: "2026-07-09T09:01:00" });
  assert.equal(other.readReceipt, null);
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
  assert.equal(ADMIN_AUTHOR, "Circle");
});

test("deepLinkCta labels each safe in-app route family and coerces loose shapes", () => {
  // Detail routes get a purpose-fit label; the id segment's case is preserved.
  assert.deepEqual(deepLinkCta("#/events/42"), { href: "#/events/42", label: "View event" });
  assert.deepEqual(deepLinkCta("/events/42"), { href: "#/events/42", label: "View event" });
  assert.deepEqual(deepLinkCta("events/42"), { href: "#/events/42", label: "View event" });
  // TM-445: the chat CTA reuses the shared event-chat entry constant, so the two copies can't drift.
  assert.equal(EVENT_CHAT_ENTRY_LABEL, "Open chat");
  assert.deepEqual(deepLinkCta("#/chat/7"), { href: "#/chat/7", label: EVENT_CHAT_ENTRY_LABEL });
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

test("threadSignature changes when another member's reaction chips change (TM-731)", () => {
  // Same count / last-id / last-sortAt — only the reaction chips differ, so the OLD count-based
  // signature would have said "nothing new" and never repainted the other member's reaction.
  const base = [{ id: "1", sortAt: 100, reactions: [] }];
  const reacted = [{ id: "1", sortAt: 100, reactions: [{ emoji: "👍", count: 1, mine: false }] }];
  assert.notEqual(threadSignature(base), threadSignature(reacted));
  // A count bump (another member also reacted 👍) is a further change.
  const reactedMore = [{ id: "1", sortAt: 100, reactions: [{ emoji: "👍", count: 2, mine: false }] }];
  assert.notEqual(threadSignature(reacted), threadSignature(reactedMore));
  // `mine` flipping (I reacted) also changes it.
  const reactedMine = [{ id: "1", sortAt: 100, reactions: [{ emoji: "👍", count: 1, mine: true }] }];
  assert.notEqual(threadSignature(reacted), threadSignature(reactedMine));
  // Identical chips → stable (the poll still won't repaint when nothing changed).
  assert.equal(
    threadSignature(reacted),
    threadSignature([{ id: "1", sortAt: 100, reactions: [{ emoji: "👍", count: 1, mine: false }] }]),
  );
});

test("threadSignature changes when a read receipt count changes (TM-731)", () => {
  const sent = [{ id: "1", sortAt: 100, readReceipt: { count: 0, readerIds: [] } }];
  const read = [{ id: "1", sortAt: 100, readReceipt: { count: 1, readerIds: ["u1"] } }];
  // "Sent" → "Read by 1": no new row, so without folding the receipt in the poll never repaints it.
  assert.notEqual(threadSignature(sent), threadSignature(read));
  // A null receipt (not the caller's own message) differs from a zero-count receipt.
  assert.notEqual(threadSignature(sent), threadSignature([{ id: "1", sortAt: 100, readReceipt: null }]));
});

test("mergeLiveMessage preserves the POST-confirmed reply quote + receipt against a lean broadcast (TM-731)", () => {
  // The rich message we already hold from the direct POST response.
  const confirmed = {
    id: "42", sortAt: 200, body: "hi",
    replyTo: { id: "7", excerpt: "the parent" },
    readReceipt: { count: 1, readerIds: ["u1"] },
  };
  const loaded = [{ id: "1", sortAt: 100 }, confirmed];
  // The fan-out echo of the SAME message: a lean frame with NO reply quote and NO receipt.
  const broadcast = { id: "42", sortAt: 200, body: "hi", replyTo: null, readReceipt: null };
  const merged = mergeLiveMessage(loaded, broadcast);
  const row = merged.find((m) => m.id === "42");
  assert.deepEqual(row.replyTo, { id: "7", excerpt: "the parent" }); // reply quote survived
  assert.deepEqual(row.readReceipt, { count: 1, readerIds: ["u1"] }); // receipt survived
  assert.equal(merged.length, 2); // de-duped, not double-rendered
  assert.deepEqual(merged.map((m) => m.id), ["1", "42"]); // order kept
});

test("mergeLiveMessage inserts a brand-new broadcast message like upsertMessage (TM-731)", () => {
  const loaded = [{ id: "1", sortAt: 100 }];
  const fresh = { id: "9", sortAt: 300, body: "new", replyTo: null, readReceipt: null };
  const merged = mergeLiveMessage(loaded, fresh);
  assert.deepEqual(merged.map((m) => m.id), ["1", "9"]); // appended in order
  assert.equal(loaded.length, 1); // input not mutated
  // A frame without an id is a harmless no-op copy.
  assert.deepEqual(mergeLiveMessage(loaded, { sortAt: 1 }).map((m) => m.id), ["1"]);
});

test("mergeLiveMessage applies a broadcast's OWN richer fields when the incumbent lacked them (TM-731)", () => {
  // Incumbent had no receipt yet; a later broadcast that DOES carry one must win (don't preserve null).
  const loaded = [{ id: "5", sortAt: 100, body: "x", replyTo: null, readReceipt: null }];
  const withReceipt = { id: "5", sortAt: 100, body: "x", replyTo: { id: "2" }, readReceipt: { count: 3, readerIds: [] } };
  const row = mergeLiveMessage(loaded, withReceipt).find((m) => m.id === "5");
  assert.deepEqual(row.readReceipt, { count: 3, readerIds: [] });
  assert.deepEqual(row.replyTo, { id: "2" });
});

/* ─────────────────────────────── live transport: SSE frame parser (TM-464) ─────────────────────── */

test("parseSseFrame reads the event name + data, defaulting the type to 'message'", () => {
  assert.deepEqual(parseSseFrame("event:message\ndata:{\"id\":1}"), {
    event: "message",
    data: '{"id":1}',
    id: undefined,
  });
  // No event: field -> the SSE default type "message".
  assert.deepEqual(parseSseFrame("data:hello"), { event: "message", data: "hello", id: undefined });
  // A single leading space after the colon is stripped (per spec); an id: is captured.
  assert.deepEqual(parseSseFrame("event: open\ndata: {}\nid: 7"), { event: "open", data: "{}", id: "7" });
});

test("parseSseFrame joins multi-line data with newlines and ignores comments", () => {
  assert.equal(parseSseFrame("data:line one\ndata:line two").data, "line one\nline two");
  // A comment-only frame (our :keep-alive heartbeat) carries no data -> not a dispatchable event.
  assert.equal(parseSseFrame(":keep-alive"), null);
  assert.equal(parseSseFrame(""), null);
});

test("createSseParser emits complete events and buffers a partial one across chunks", () => {
  const parser = createSseParser();
  // One whole event plus the start of a second in the first chunk.
  let events = parser.push("event:message\ndata:{\"id\":1}\n\nevent:message\ndata:{\"id\":2}");
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"id":1}');
  // The second event only completes once its blank-line boundary arrives in a later chunk.
  events = parser.push("\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"id":2}');
});

test("createSseParser tolerates CRLF line endings and filters heartbeat comments", () => {
  const parser = createSseParser();
  const events = parser.push(":keep-alive\r\n\r\nevent:message\r\ndata:{\"id\":9}\r\n\r\n");
  assert.equal(events.length, 1); // the comment frame is dropped, the message frame kept
  assert.deepEqual(JSON.parse(events[0].data), { id: 9 });
});

test("createSseParser handles the server's initial open frame then live messages", () => {
  const parser = createSseParser();
  const events = parser.push(
    'event:open\ndata:{"conversationId":42}\n\nevent:message\ndata:{"id":100,"body":"hi"}\n\n',
  );
  assert.deepEqual(
    events.map((e) => e.event),
    ["open", "message"],
  );
  assert.equal(JSON.parse(events[1].data).body, "hi");
});

/* ─────────────────────────────── reply / quote (TM-466) ────────────────────────────────────────── */

test("quoteExcerpt: collapses whitespace, trims, and truncates with an ellipsis", () => {
  assert.equal(quoteExcerpt("  hi   team  "), "hi team");
  assert.equal(quoteExcerpt("line one\n\nline two"), "line one line two");
  assert.equal(quoteExcerpt(""), "");
  assert.equal(quoteExcerpt(null), "");
  const long = "a".repeat(QUOTE_EXCERPT_MAX + 50);
  const cut = quoteExcerpt(long);
  assert.equal(cut.length, QUOTE_EXCERPT_MAX);
  assert.ok(cut.endsWith("…"));
  // At the cap exactly → untouched, no ellipsis.
  const exact = "b".repeat(QUOTE_EXCERPT_MAX);
  assert.equal(quoteExcerpt(exact), exact);
});

test("toQuotedPreview: maps a live parent snippet, null for a non-reply", () => {
  assert.equal(toQuotedPreview(null), null);
  assert.equal(toQuotedPreview(undefined), null);
  const live = toQuotedPreview({ id: 7, senderId: 3, system: false, excerpt: "who's in?", available: true });
  assert.deepEqual(live, { id: "7", system: false, available: true, excerpt: "who's in?" });
});

test("toQuotedPreview: a removed parent is 'message unavailable' with no leaked excerpt", () => {
  // available:false — the backend withholds the excerpt (null); we substitute the AC's copy.
  const gone = toQuotedPreview({ id: 9, senderId: null, system: false, excerpt: null, available: false });
  assert.equal(gone.available, false);
  assert.equal(gone.excerpt, MESSAGE_UNAVAILABLE);
  assert.equal(gone.id, "9"); // id kept for tap-to-scroll / provenance
});

test("toThreadMessage: carries the quoted parent through as replyTo (null when absent)", () => {
  const reply = toThreadMessage({
    id: 5, body: "answer", createdAt: "2026-07-09T10:00:00Z",
    replyTo: { id: 4, senderId: 2, system: false, excerpt: "question?", available: true },
  });
  assert.equal(reply.replyTo.id, "4");
  assert.equal(reply.replyTo.excerpt, "question?");
  assert.equal(reply.replyTo.available, true);
  // A normal (non-reply) message → null replyTo.
  assert.equal(toThreadMessage({ id: 6, body: "hi", createdAt: "2026-07-09T10:01:00Z" }).replyTo, null);
});

test("replyTargetFrom: builds a composer reply target (id + local excerpt) from a message VM", () => {
  const target = replyTargetFrom({ id: 12, body: "  bring   the ball  ", system: false });
  assert.deepEqual(target, { id: "12", excerpt: "bring the ball", system: false, available: true });
  // A message with no id can't be a reply target.
  assert.equal(replyTargetFrom({ body: "no id" }), null);
  assert.equal(replyTargetFrom(null), null);
});

test("pendingMessage: carries the reply preview so the optimistic echo shows the quote", () => {
  const preview = { id: "4", excerpt: "question?", system: false, available: true };
  const echo = pendingMessage("my answer", { localId: "p1", replyTo: preview });
  assert.equal(echo.pending, true);
  assert.deepEqual(echo.replyTo, preview);
  // Default (no reply) → null replyTo, same as a plain send.
  assert.equal(pendingMessage("plain", { localId: "p2" }).replyTo, null);
});

/* ─────────────────────────────── Typing indicators (TM-465) ──────────────────────────────────────── */

test("typistName: trims a real name, falls back to 'Someone' for a blank/absent one", () => {
  assert.equal(typistName("  Amina  "), "Amina");
  assert.equal(typistName(""), "Someone");
  assert.equal(typistName("   "), "Someone");
  assert.equal(typistName(null), "Someone");
  assert.equal(typistName(undefined), "Someone");
});

test("shouldSignalTyping: debounces to at most one signal per window", () => {
  // Never signalled yet → send.
  assert.equal(shouldSignalTyping(0, 10_000), true);
  assert.equal(shouldSignalTyping(null, 10_000), true);
  // Within the window since the last signal → hold.
  assert.equal(shouldSignalTyping(10_000, 10_000 + TYPING_DEBOUNCE_MS - 1), false);
  // At/after the window → send again.
  assert.equal(shouldSignalTyping(10_000, 10_000 + TYPING_DEBOUNCE_MS), true);
  // Custom interval respected.
  assert.equal(shouldSignalTyping(0, 5, 1000), true);
  assert.equal(shouldSignalTyping(5, 500, 1000), false);
});

test("applyTypingEvent: upserts a typist keyed by user id with a fresh expiry, never mutating input", () => {
  const now = 1000;
  const start = applyTypingEvent([], { userId: 7, name: "Amina", typing: true }, now);
  assert.deepEqual(start, [{ userId: "7", name: "Amina", expiresAt: now + TYPING_TTL_MS }]);

  // A second signal from the SAME person refreshes the single entry (keyed by id), never stacks.
  const refreshed = applyTypingEvent(start, { userId: "7", name: "Amina", typing: true }, now + 2000);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].expiresAt, now + 2000 + TYPING_TTL_MS);

  // The input array is not mutated (returns a new array).
  assert.equal(start[0].expiresAt, now + TYPING_TTL_MS);
});

test("applyTypingEvent: an explicit stop (typing:false) removes that typist immediately", () => {
  const now = 0;
  let list = applyTypingEvent([], { userId: 1, name: "A", typing: true }, now);
  list = applyTypingEvent(list, { userId: 2, name: "B", typing: true }, now);
  assert.equal(list.length, 2);
  list = applyTypingEvent(list, { userId: 1, typing: false }, now);
  assert.deepEqual(list.map((t) => t.userId), ["2"]);
});

test("applyTypingEvent: a signal with no user id is ignored (can't be keyed)", () => {
  const list = applyTypingEvent([{ userId: "9", name: "Z", expiresAt: 999 }], { name: "nobody", typing: true }, 0);
  assert.deepEqual(list, [{ userId: "9", name: "Z", expiresAt: 999 }]); // unchanged (a copy)
});

test("pruneTypists: drops entries whose expiry has passed", () => {
  const list = [
    { userId: "1", name: "A", expiresAt: 100 },
    { userId: "2", name: "B", expiresAt: 300 },
  ];
  assert.deepEqual(pruneTypists(list, 200).map((t) => t.userId), ["2"]); // A expired, B lives
  assert.deepEqual(pruneTypists(list, 50).map((t) => t.userId), ["1", "2"]); // both live
  assert.deepEqual(pruneTypists(list, 300), []); // at expiry → gone (strict >)
});

test("typingLabel: aggregates 0 / 1 / 2 / 3+ typists, expiring stale ones first", () => {
  const now = 0;
  const at = (n) => now + TYPING_TTL_MS; // all fresh
  assert.equal(typingLabel([], now), "");
  assert.equal(typingLabel([{ userId: "1", name: "Amina", expiresAt: at() }], now), "Amina is typing…");
  assert.equal(
    typingLabel([
      { userId: "1", name: "Amina", expiresAt: at() },
      { userId: "2", name: "Bilal", expiresAt: at() },
    ], now),
    "Amina and Bilal are typing…",
  );
  // 3 → "and 1 other"; 4 → "and 2 others".
  const three = [
    { userId: "1", name: "Amina", expiresAt: at() },
    { userId: "2", name: "Bilal", expiresAt: at() },
    { userId: "3", name: "Carmen", expiresAt: at() },
  ];
  assert.equal(typingLabel(three, now), "Amina, Bilal and 1 other are typing…");
  assert.equal(typingLabel([...three, { userId: "4", name: "Dan", expiresAt: at() }], now), "Amina, Bilal and 2 others are typing…");
});

test("typingLabel: a typist whose signal expired is dropped from the label", () => {
  const list = [
    { userId: "1", name: "Amina", expiresAt: 100 },
    { userId: "2", name: "Bilal", expiresAt: 5000 },
  ];
  // At now=200, Amina expired → only Bilal remains.
  assert.equal(typingLabel(list, 200), "Bilal is typing…");
});

/* ─────────────────────────────── author edit / delete own message (TM-467) ─────────────────────── */

test("toThreadMessage: carries the server `mine` flag (strictly true) + the `edited`/`editedAt` tag", () => {
  // mine is strict: only a concrete server `true` marks a message own; false/absent/null → not mine.
  assert.equal(toThreadMessage({ id: 1, body: "hi", mine: true }).mine, true);
  assert.equal(toThreadMessage({ id: 1, body: "hi", mine: false }).mine, false);
  assert.equal(toThreadMessage({ id: 1, body: "hi" }).mine, false); // absent (e.g. broadcast frame)
  assert.equal(toThreadMessage({ id: 1, body: "hi", mine: null }).mine, false);

  // edited/editedAt drive the "edited" tag: a non-null editedAt → edited true, carried through as a string.
  const notEdited = toThreadMessage({ id: 2, body: "hi", createdAt: "2026-07-10T10:00:00Z" });
  assert.equal(notEdited.edited, false);
  assert.equal(notEdited.editedAt, null);
  const edited = toThreadMessage({ id: 2, body: "hi (fixed)", createdAt: "2026-07-10T10:00:00Z", editedAt: "2026-07-10T10:02:00Z" });
  assert.equal(edited.edited, true);
  assert.equal(edited.editedAt, "2026-07-10T10:02:00Z");
});

test("pendingMessage: an optimistic echo is `mine` and not yet edited", () => {
  const p = pendingMessage("sending this", { localId: "pending-x" });
  assert.equal(p.mine, true);
  assert.equal(p.edited, false);
  assert.equal(p.editedAt, null);
  assert.equal(p.pending, true);
});

test("canEditWithinWindow: allowed up to (and including) EDIT_WINDOW_MS after posting, then locked", () => {
  const created = Date.parse("2026-07-10T10:00:00Z");
  assert.equal(canEditWithinWindow(created, created), true); // just posted
  assert.equal(canEditWithinWindow(created, created + EDIT_WINDOW_MS - 1), true); // inside the window
  assert.equal(canEditWithinWindow(created, created + EDIT_WINDOW_MS), true); // exactly at the edge (inclusive)
  assert.equal(canEditWithinWindow(created, created + EDIT_WINDOW_MS + 1), false); // one ms past → locked
  // Accepts an ISO string too; an absent/garbage timestamp is treated as out-of-window (no edit offered).
  assert.equal(canEditWithinWindow("2026-07-10T10:00:00Z", created + 1000), true);
  assert.equal(canEditWithinWindow(null, created), false);
  assert.equal(canEditWithinWindow("not-a-date", created), false);
});

test("EDIT_WINDOW_MS is the 5-minute window; EDITED_TAG is the shared 'edited' string", () => {
  assert.equal(EDIT_WINDOW_MS, 5 * 60 * 1000);
  assert.equal(EDITED_TAG, "edited");
});

test("applyMessageEdit: patches ONLY body+editedAt by id, preserving reactions/order, non-mutating", () => {
  const chips = [{ emoji: "👍", count: 2, mine: true }];
  const before = [
    { id: "1", body: "first", sortAt: 1, editedAt: null, edited: false, reactions: [] },
    { id: "2", body: "typo heer", sortAt: 2, editedAt: null, edited: false, reactions: chips, readReceipt: { count: 1, readerIds: ["9"] } },
  ];
  const after = applyMessageEdit(before, { id: "2", body: "typo here", editedAt: "2026-07-10T10:05:00Z" });
  // The edited row's body + editedAt + edited flip; everything else on it is preserved (reactions, receipt).
  assert.equal(after[1].body, "typo here");
  assert.equal(after[1].editedAt, "2026-07-10T10:05:00Z");
  assert.equal(after[1].edited, true);
  assert.deepEqual(after[1].reactions, chips);
  assert.deepEqual(after[1].readReceipt, { count: 1, readerIds: ["9"] });
  // Order preserved; the OTHER row is untouched (same reference — only the edited one is a new object).
  assert.equal(after[0], before[0]);
  assert.equal(after.length, 2);
  // Non-mutating: the input's row is unchanged.
  assert.equal(before[1].body, "typo heer");
  assert.equal(before[1].edited, false);
  // A missing id is a harmless no-op copy.
  assert.deepEqual(applyMessageEdit(before, { id: "999", body: "x" }).map((m) => m.body), ["first", "typo heer"]);
  assert.deepEqual(applyMessageEdit(before, {}).map((m) => m.body), ["first", "typo heer"]);
});

test("removeMessageById: drops a message by id (the soft-delete timeline effect), non-mutating no-op otherwise", () => {
  const before = [
    { id: "1", body: "keep" },
    { id: "2", body: "gone" },
    { id: "3", body: "keep too" },
  ];
  assert.deepEqual(removeMessageById(before, "2").map((m) => m.id), ["1", "3"]);
  assert.deepEqual(removeMessageById(before, 2).map((m) => m.id), ["1", "3"]); // coerces a numeric id
  // A missing / blank id leaves the list intact (a copy).
  assert.deepEqual(removeMessageById(before, "999").map((m) => m.id), ["1", "2", "3"]);
  assert.deepEqual(removeMessageById(before, "").map((m) => m.id), ["1", "2", "3"]);
  assert.equal(before.length, 3); // non-mutating
});

test("threadSignature: an in-place edit (same count/last-id/last-sortAt) still changes the signature", () => {
  const base = [
    { id: "1", sortAt: 1, editedAt: null },
    { id: "2", sortAt: 2, editedAt: null },
  ];
  const editedInPlace = [
    { id: "1", sortAt: 1, editedAt: null },
    { id: "2", sortAt: 2, editedAt: "2026-07-10T10:05:00Z" },
  ];
  // Count + last id + last sortAt are identical, but the edit must be detectable so a poll repaints it.
  assert.notEqual(threadSignature(base), threadSignature(editedInPlace));
});

// ── announcement classification (TM-710) ───────────────────────────────────────────────────────────

test("isAnnouncement: only the ANNOUNCEMENT kind counts", () => {
  assert.equal(isAnnouncement({ kind: "ANNOUNCEMENT" }), true);
  assert.equal(isAnnouncement({ kind: "ATTENDEE" }), false);
});

test("isAnnouncement: case-insensitive + whitespace-tolerant (defensive against payload casing)", () => {
  assert.equal(isAnnouncement({ kind: "announcement" }), true);
  assert.equal(isAnnouncement({ kind: "  Announcement  " }), true);
});

test("isAnnouncement: degrades safely with a missing / unknown / non-string kind", () => {
  assert.equal(isAnnouncement({}), false); // every pre-TM-710 message (no kind) is a normal message
  assert.equal(isAnnouncement(undefined), false);
  assert.equal(isAnnouncement({ kind: null }), false);
  assert.equal(isAnnouncement({ kind: 42 }), false);
  assert.equal(isAnnouncement({ kind: "SOMETHING_ELSE" }), false);
});

test("toThreadMessage: carries the announcement flag from the message kind", () => {
  const now = new Date("2026-07-14T12:00:00Z");
  const announcement = toThreadMessage(
    { id: 7, body: "Doors open at 7pm", kind: "ANNOUNCEMENT", createdAt: "2026-07-14T11:00:00Z" }, now);
  assert.equal(announcement.announcement, true);
  assert.equal(announcement.body, "Doors open at 7pm");

  const ordinary = toThreadMessage(
    { id: 8, body: "see you there", kind: "ATTENDEE", createdAt: "2026-07-14T11:01:00Z" }, now);
  assert.equal(ordinary.announcement, false);

  // A legacy message with no kind is a normal attendee message, never an announcement.
  const legacy = toThreadMessage({ id: 9, body: "hi", createdAt: "2026-07-14T11:02:00Z" }, now);
  assert.equal(legacy.announcement, false);
});

/* ─────────────────── viewer admin-flag cache (TM-736 announce-toggle fix) ─────────────────────── */

test("createAdminFlagCache: invalidate() drops the cached flag so a re-resolve picks up the new role (TM-736)", async () => {
  // The TM-736 repro: /me first answers non-admin (the flag resolved before the ADMIN claim was
  // live, or for a previous user), then admin. A cache WITHOUT invalidate keeps the stale `false`
  // for the whole session and the announce toggle never mounts — this test FAILS on that shape.
  const roles = [{ role: "MEMBER" }, { role: "ADMIN" }];
  let fetches = 0;
  const cache = createAdminFlagCache(async () => roles[fetches++]);

  assert.equal(await cache.resolve(), false); // first resolve: non-admin, and it caches…
  assert.equal(await cache.resolve(), false); // …so a repeat resolve answers from cache, no re-fetch
  assert.equal(fetches, 1);

  cache.invalidate(); // auth changed (chat.js wires this to onAuthChanged)

  assert.equal(await cache.resolve(), true); // re-fetches → the now-admin role is seen
  assert.equal(await cache.resolve(), true); // and the fresh value is cached again
  assert.equal(fetches, 2);
});

test("createAdminFlagCache: resolves role case-insensitively and only for ADMIN", async () => {
  assert.equal(await createAdminFlagCache(async () => ({ role: "admin" })).resolve(), true);
  assert.equal(await createAdminFlagCache(async () => ({ role: "ADMIN" })).resolve(), true);
  assert.equal(await createAdminFlagCache(async () => ({ role: "MEMBER" })).resolve(), false);
  assert.equal(await createAdminFlagCache(async () => ({})).resolve(), false);
  assert.equal(await createAdminFlagCache(async () => null).resolve(), false);
});

test("createAdminFlagCache: a failed /me is NOT cached — the next resolve() retries (TM-736)", async () => {
  // TM-736 residual: a transient /me failure during boot used to CACHE false, so the admin announce
  // toggle stayed hidden for the whole session (until an auth change that may never come). The failure
  // must not stick — it returns false for that call (affordance hidden, server still gates) but the
  // next resolve() re-fetches. FAILS on the old cache-false shape (second resolve answers false, no
  // re-fetch); passes now.
  let fail = true;
  let fetches = 0;
  const cache = createAdminFlagCache(async () => {
    fetches += 1;
    if (fail) throw new Error("boom");
    return { role: "ADMIN" };
  });
  assert.equal(await cache.resolve(), false); // transient failure → hidden this call, never throws
  fail = false;
  assert.equal(await cache.resolve(), true); // NOT cached → re-fetches, sees the live ADMIN role
  assert.equal(fetches, 2); // proves the retry actually happened (old code would be 1)
});
