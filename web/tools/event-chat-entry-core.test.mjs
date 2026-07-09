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
