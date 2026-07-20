// Tests for the event-detail "Open chat" entry logic (TM-450). Framework-free — Node's built-in test
// runner, picked up by the CI gate glob `node --test web/tools/*.test.mjs`.
//
// The entry point on the event detail has to answer two independent questions before it can render an
// "Open chat" deep-link into the event's group-chat thread:
//   1. is this viewer allowed to chat?  → isEventChatMember  (a GOING attendee, or an admin)
//   2. does the thread actually exist?   → findEventConversation (match a conversation on eventId)
// eventChatEntryModel composes both into the exact model the view renders. All three are pure (no DOM /
// no fetch), so the whole gating decision — including the AC's "hidden or disabled with a hint for
// non-members" — is asserted here rather than in the DOM view.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EVENT_CHAT_ENTRY_LABEL,
  isEventChatMember,
  findEventConversation,
  collectConversationsForEvent,
  eventChatEntryModel,
} from "../src/assets/events-core.js";

// A GOING attendee (non-admin) and the EVENT_GROUP thread for event 42.
const goingDetail = { id: 42, myState: "GOING" };
const memberUser = { role: "USER" };
const adminUser = { role: "ADMIN" };
const eventThread = { id: 900, eventId: 42, type: "EVENT_GROUP", title: "Coffee morning" };

// ---------------------------------------------------------------- isEventChatMember (eligibility)

test("isEventChatMember: a GOING attendee is a member", () => {
  assert.equal(isEventChatMember({ myState: "GOING" }, { role: "USER" }), true);
});

test("isEventChatMember: an admin is a member whatever their RSVP state (the host/admin case)", () => {
  assert.equal(isEventChatMember({ myState: "NONE" }, adminUser), true);
  assert.equal(isEventChatMember({ myState: "WAITLISTED" }, adminUser), true);
  assert.equal(isEventChatMember({ myState: null }, adminUser), true);
});

test("isEventChatMember: admin role is matched case-insensitively (defensive against /me casing)", () => {
  assert.equal(isEventChatMember({ myState: "NONE" }, { role: "admin" }), true);
});

test("isEventChatMember: WAITLISTED / NONE non-admins are NOT members", () => {
  assert.equal(isEventChatMember({ myState: "WAITLISTED" }, memberUser), false);
  assert.equal(isEventChatMember({ myState: "NONE" }, memberUser), false);
});

test("isEventChatMember: degrades safely with missing detail / me", () => {
  assert.equal(isEventChatMember(undefined, undefined), false);
  assert.equal(isEventChatMember({ myState: "GOING" }, null), true); // GOING alone is enough
  assert.equal(isEventChatMember(null, adminUser), true); // admin alone is enough
});

// ---------------------------------------------------------------- findEventConversation (thread)

test("findEventConversation: matches the EVENT_GROUP thread by eventId", () => {
  const convos = [
    { id: 1, type: "ADMIN_BROADCAST", title: "Announcements" },
    eventThread,
  ];
  assert.equal(findEventConversation(convos, 42), eventThread);
});

test("findEventConversation: tolerates a number/string eventId mismatch (both are int64 in JSON)", () => {
  // The API serialises int64 ids as numbers, but be robust to either side arriving as a string.
  assert.equal(findEventConversation([{ id: 5, eventId: "42", type: "EVENT_GROUP" }], 42)?.id, 5);
  assert.equal(findEventConversation([{ id: 5, eventId: 42, type: "EVENT_GROUP" }], "42")?.id, 5);
});

test("findEventConversation: never matches a non-EVENT_GROUP conversation", () => {
  const convos = [{ id: 1, eventId: 42, type: "ADMIN_BROADCAST" }];
  assert.equal(findEventConversation(convos, 42), null);
});

test("findEventConversation: returns null when no thread matches the event", () => {
  assert.equal(findEventConversation([eventThread], 99), null);
});

test("findEventConversation: degrades safely (empty / null / no eventId)", () => {
  assert.equal(findEventConversation([], 42), null);
  assert.equal(findEventConversation(null, 42), null);
  assert.equal(findEventConversation(undefined, 42), null);
  assert.equal(findEventConversation([eventThread], null), null);
  assert.equal(findEventConversation([{ id: 1, type: "EVENT_GROUP" }], 42), null); // no eventId
});

// ---------------------------------------------------------------- collectConversationsForEvent (TM-853)

// A fake paged GET /me/conversations: serves `all` in fixed windows of `pageSize` (the server caps the
// page size, so a caller can't sidestep paging by asking for a huge page) in the shared page envelope,
// recording which pages were requested.
function pagedServer(all, { pageSize = 20 } = {}) {
  const calls = [];
  return {
    calls,
    fetchPage: async (page) => {
      calls.push(page);
      const start = page * pageSize;
      return {
        items: all.slice(start, start + pageSize),
        page,
        size: pageSize,
        totalElements: all.length,
        totalPages: Math.ceil(all.length / pageSize),
      };
    },
  };
}

// 24 EVENT_GROUP threads for OTHER events — enough that, at the server's page size of 20, anything
// appended after them lands beyond the first page (the TM-853 regression shape: a chatty user).
const otherThreads = Array.from({ length: 24 }, (_, i) => ({
  id: 100 + i,
  eventId: 1000 + i,
  type: "EVENT_GROUP",
}));

test("collect: TM-853 — resolves a thread that is NOT in the first page (25 conversations, target last)", async () => {
  const server = pagedServer([...otherThreads, eventThread]); // 25 items; event 42's thread is #25, on page 1
  const conversations = await collectConversationsForEvent(server.fetchPage, 42);
  assert.equal(findEventConversation(conversations, 42), eventThread);
  assert.deepEqual(server.calls, [0, 1]); // it actually paged past the first window
  // And the composed model — what the detail renders — now carries the live deep-link.
  const model = eventChatEntryModel({ detail: goingDetail, me: memberUser, conversations });
  assert.equal(model.enabled, true);
  assert.equal(model.href, "#/chat/900");
});

test("collect: stops after the first page when the thread is already there (no over-fetching)", async () => {
  const server = pagedServer([eventThread, ...otherThreads]);
  const conversations = await collectConversationsForEvent(server.fetchPage, 42);
  assert.equal(findEventConversation(conversations, 42), eventThread);
  assert.deepEqual(server.calls, [0]);
});

test("collect: exhausts every page when no thread matches, so the not-ready hint is honest", async () => {
  const server = pagedServer([...otherThreads, ...otherThreads.map((t) => ({ ...t, id: t.id + 50, eventId: t.eventId + 50 }))]); // 48 items, 3 pages, no event-42 thread
  const conversations = await collectConversationsForEvent(server.fetchPage, 42);
  assert.equal(conversations.length, 48);
  assert.deepEqual(server.calls, [0, 1, 2]);
  const model = eventChatEntryModel({ detail: goingDetail, me: memberUser, conversations });
  assert.equal(model.enabled, false);
  assert.match(model.reason, /ready/i);
});

test("collect: degrades safely on an empty list (single request, empty result)", async () => {
  const server = pagedServer([]);
  const conversations = await collectConversationsForEvent(server.fetchPage, 42);
  assert.deepEqual(conversations, []);
  assert.deepEqual(server.calls, [0]);
});

test("collect: the maxPages cap halts a misbehaving envelope (never loops forever)", async () => {
  let calls = 0;
  // A pathological server: always claims more pages and keeps returning items.
  const fetchPage = async (page) => {
    calls++;
    return { items: [{ id: page, eventId: 9999, type: "EVENT_GROUP" }], page, size: 1, totalElements: 999999, totalPages: 999999 };
  };
  await collectConversationsForEvent(fetchPage, 42, { maxPages: 3 });
  assert.equal(calls, 3);
});

// ---------------------------------------------------------------- eventChatEntryModel (composed)

test("model: GOING attendee + existing thread → an ENABLED deep-link into #/chat/{conversationId}", () => {
  const model = eventChatEntryModel({ detail: goingDetail, me: memberUser, conversations: [eventThread] });
  assert.equal(model.eligible, true);
  assert.equal(model.enabled, true);
  assert.equal(model.label, EVENT_CHAT_ENTRY_LABEL);
  assert.equal(model.conversationId, 900);
  assert.equal(model.href, "#/chat/900");
  assert.equal(model.reason, undefined);
});

test("model: admin + existing thread → ENABLED even when the admin isn't GOING (host/admin)", () => {
  const model = eventChatEntryModel({
    detail: { id: 42, myState: "NONE" },
    me: adminUser,
    conversations: [eventThread],
  });
  assert.equal(model.enabled, true);
  assert.equal(model.href, "#/chat/900");
});

test("model: eligible member but the thread isn't provisioned yet → DISABLED with a not-ready hint", () => {
  const model = eventChatEntryModel({ detail: goingDetail, me: memberUser, conversations: [] });
  assert.equal(model.eligible, true);
  assert.equal(model.enabled, false);
  assert.equal(model.href, undefined);
  assert.match(model.reason, /ready/i);
});

test("model: WAITLISTED non-member → DISABLED with an RSVP hint, no deep-link (AC non-member case)", () => {
  const model = eventChatEntryModel({
    detail: { id: 42, myState: "WAITLISTED" },
    me: memberUser,
    conversations: [eventThread], // even if a thread exists, a non-member gets no link
  });
  assert.equal(model.eligible, false);
  assert.equal(model.enabled, false);
  assert.equal(model.href, undefined);
  assert.equal(model.conversationId, undefined);
  assert.match(model.reason, /going|rsvp/i);
});

test("model: NONE non-member with no conversations → DISABLED non-member hint", () => {
  const model = eventChatEntryModel({ detail: { id: 42, myState: "NONE" }, me: memberUser });
  assert.equal(model.eligible, false);
  assert.equal(model.enabled, false);
  assert.equal(model.label, EVENT_CHAT_ENTRY_LABEL);
});

test("model: encodes the conversation id into the deep-link href", () => {
  const model = eventChatEntryModel({
    detail: goingDetail,
    me: memberUser,
    conversations: [{ id: "a/b 7", eventId: 42, type: "EVENT_GROUP" }],
  });
  assert.equal(model.href, "#/chat/a%2Fb%207");
});
