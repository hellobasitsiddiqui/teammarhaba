// Unit tests (TM-443) for the pure admin-compose core — validation, payload building, the ~50-recipient
// confirmation logic, and the result summary — asserted without a browser (the broadcast.js /
// event-form.js split). Runs on the PR gate via `node --test web/tools/*.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_TITLE,
  MAX_BODY,
  MAX_USER_IDS,
  MAX_EVENT_IDS,
  CONFIRM_THRESHOLD,
  TARGET_TYPES,
  validateAdminMessage,
  buildAdminMessagePayload,
  resolvedRecipientCount,
  isLargeAudience,
  describeAudience,
  confirmCopy,
  summariseSend,
} from "../src/assets/admin-messages-core.js";

// A valid baseline draft (user target, one recipient) each test tweaks.
const base = () => ({
  title: "Heads up",
  body: "The venue changed for tonight.",
  deepLink: "",
  targetType: "user",
  userIds: [7],
  city: "",
  eventIds: [],
});

// --- caps mirror the backend DTO --------------------------------------------------------------

test("caps mirror AdminMessageRequest", () => {
  assert.equal(MAX_TITLE, 120);
  assert.equal(MAX_BODY, 5000);
  assert.equal(MAX_USER_IDS, 500);
  assert.equal(MAX_EVENT_IDS, 50);
  assert.deepEqual(TARGET_TYPES, ["user", "city", "event"]);
});

// --- validation -------------------------------------------------------------------------------

test("a well-formed user draft passes", () => {
  const v = validateAdminMessage(base());
  assert.equal(v.canSend, true);
  assert.equal(v.title, "");
  assert.equal(v.body, "");
  assert.equal(v.audience, "");
});

test("title is required and length-capped", () => {
  assert.equal(validateAdminMessage({ ...base(), title: "   " }).title, "Title is required.");
  const longTitle = "x".repeat(MAX_TITLE + 1);
  assert.match(validateAdminMessage({ ...base(), title: longTitle }).title, /120 characters or fewer/);
  // Exactly at the cap is fine.
  assert.equal(validateAdminMessage({ ...base(), title: "x".repeat(MAX_TITLE) }).title, "");
});

test("body is required and length-capped", () => {
  assert.equal(validateAdminMessage({ ...base(), body: "" }).body, "Message is required.");
  assert.match(validateAdminMessage({ ...base(), body: "x".repeat(MAX_BODY + 1) }).body, /5000 characters or fewer/);
});

test("user target needs at least one recipient, within the cap", () => {
  assert.equal(validateAdminMessage({ ...base(), userIds: [] }).audience, "Pick at least one recipient.");
  const over = Array.from({ length: MAX_USER_IDS + 1 }, (_, i) => i + 1);
  assert.match(validateAdminMessage({ ...base(), userIds: over }).audience, /at most 500 recipients/);
});

test("city target needs a non-blank city", () => {
  const draft = { ...base(), targetType: "city", userIds: [], city: "" };
  assert.equal(validateAdminMessage(draft).audience, "Enter a city to send to.");
  assert.equal(validateAdminMessage({ ...draft, city: "London" }).canSend, true);
});

test("event target needs at least one event, within the cap", () => {
  const draft = { ...base(), targetType: "event", userIds: [], eventIds: [] };
  assert.equal(validateAdminMessage(draft).audience, "Pick at least one event.");
  const over = Array.from({ length: MAX_EVENT_IDS + 1 }, (_, i) => i + 1);
  assert.match(validateAdminMessage({ ...draft, eventIds: over }).audience, /at most 50 events/);
  assert.equal(validateAdminMessage({ ...draft, eventIds: [1, 2] }).canSend, true);
});

test("a missing / unknown target type is an audience error", () => {
  assert.equal(validateAdminMessage({ ...base(), targetType: "nope" }).audience, "Choose who to send to.");
  assert.equal(validateAdminMessage({ ...base(), targetType: undefined }).audience, "Choose who to send to.");
});

test("only the CHOSEN dimension is validated — a stale other-dimension selection can't leak in", () => {
  // Target is user with NO users, but there IS a stale city + events selection. It must still fail on
  // the user dimension (the one-target-type rule made structural), not silently pass on the others.
  const draft = { ...base(), targetType: "user", userIds: [], city: "London", eventIds: [3] };
  assert.equal(validateAdminMessage(draft).audience, "Pick at least one recipient.");
});

// --- payload building -------------------------------------------------------------------------

test("user payload carries only userIds (numbers, de-duped) + the message fields", () => {
  const body = buildAdminMessagePayload({ ...base(), title: "  Hi  ", body: " Yo ", userIds: ["7", 7, "8"] });
  assert.deepEqual(body, { title: "Hi", body: "Yo", userIds: [7, 8] });
  assert.equal("cities" in body, false);
  assert.equal("eventIds" in body, false);
  assert.equal("deepLink" in body, false);
});

test("city payload sends the single city as a one-element cities list", () => {
  const body = buildAdminMessagePayload({ ...base(), targetType: "city", userIds: [], city: "  London " });
  assert.deepEqual(body, { title: "Heads up", body: "The venue changed for tonight.", cities: ["London"] });
});

test("event payload carries only eventIds", () => {
  const body = buildAdminMessagePayload({ ...base(), targetType: "event", userIds: [], eventIds: ["10", "10", "20"] });
  assert.deepEqual(body.eventIds, [10, 20]);
  assert.equal("userIds" in body, false);
  assert.equal("cities" in body, false);
});

test("a non-blank deepLink is emitted; a blank one is omitted", () => {
  const withLink = buildAdminMessagePayload({ ...base(), deepLink: "#/events/42" });
  assert.equal(withLink.deepLink, "#/events/42");
  const without = buildAdminMessagePayload({ ...base(), deepLink: "   " });
  assert.equal("deepLink" in without, false);
});

test("the payload targets EXACTLY ONE dimension even when others carry stale data", () => {
  const body = buildAdminMessagePayload({ ...base(), targetType: "city", userIds: [1, 2], city: "Leeds", eventIds: [9] });
  assert.deepEqual(Object.keys(body).sort(), ["body", "cities", "title"]);
});

// --- resolved count + confirmation ------------------------------------------------------------

test("resolvedRecipientCount is exact for user, null for city/event", () => {
  assert.equal(resolvedRecipientCount({ ...base(), userIds: [1, 2, 2, 3] }), 3);
  assert.equal(resolvedRecipientCount({ ...base(), targetType: "city", city: "London" }), null);
  assert.equal(resolvedRecipientCount({ ...base(), targetType: "event", eventIds: [1] }), null);
});

test("isLargeAudience: over the threshold, or any unknown (city/event) audience", () => {
  assert.equal(CONFIRM_THRESHOLD, 50);
  assert.equal(isLargeAudience({ ...base(), userIds: [1] }), false); // small known
  const big = Array.from({ length: CONFIRM_THRESHOLD + 1 }, (_, i) => i + 1);
  assert.equal(isLargeAudience({ ...base(), userIds: big }), true); // known, over threshold
  assert.equal(isLargeAudience({ ...base(), targetType: "city", city: "London" }), true); // unknown
  assert.equal(isLargeAudience({ ...base(), targetType: "event", eventIds: [1] }), true); // unknown
});

test("describeAudience reads only the targeted dimension", () => {
  assert.equal(describeAudience({ ...base(), userIds: [1] }), "1 person");
  assert.equal(describeAudience({ ...base(), userIds: [1, 2, 3] }), "3 people");
  assert.equal(describeAudience({ ...base(), userIds: [1] }, { userLabel: "Ada Lovelace" }), "Ada Lovelace");
  assert.equal(describeAudience({ ...base(), targetType: "city", city: "London" }), "everyone in London");
  assert.equal(describeAudience({ ...base(), targetType: "event", eventIds: [1, 2] }), "the attendees of 2 events");
  assert.equal(describeAudience({ ...base(), userIds: [] }), "");
});

test("confirmCopy surfaces the exact count for a large KNOWN audience", () => {
  const big = Array.from({ length: 84 }, (_, i) => i + 1);
  const copy = confirmCopy({ ...base(), userIds: big });
  assert.match(copy, /84 people/);
  assert.match(copy, /can't be undone/);
});

test("confirmCopy warns that an UNKNOWN audience is resolved at send time", () => {
  const copy = confirmCopy({ ...base(), targetType: "city", city: "London" });
  assert.match(copy, /everyone in London/);
  assert.match(copy, /calculated when you send/);
  assert.match(copy, /can't be undone/);
});

test("confirmCopy is the plain line for a small, known audience", () => {
  const copy = confirmCopy({ ...base(), userIds: [1] });
  assert.match(copy, /1 person/);
  assert.doesNotMatch(copy, /large audience/);
  assert.doesNotMatch(copy, /calculated when you send/);
});

// --- result summary ---------------------------------------------------------------------------

test("summariseSend reports recipients + push breakdown", () => {
  assert.equal(
    summariseSend({ recipientCount: 42, pushDelivered: 30, pushSkipped: 12 }),
    "Sent to 42 people · 30 pushed · 12 not pushed",
  );
});

test("summariseSend stays terse when there's nothing to add", () => {
  assert.equal(summariseSend({ recipientCount: 1, pushDelivered: 0, pushSkipped: 0 }), "Sent to 1 person");
  assert.equal(summariseSend({}), "Sent to 0 people");
});
