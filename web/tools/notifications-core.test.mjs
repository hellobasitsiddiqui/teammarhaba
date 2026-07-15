// Unit tests for the Notifications feed pure core (TM-515, TM-745) — the REAL-feed mapping, the unread
// count, and the immutable mark-all-read.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, like the other cores.

import assert from "node:assert/strict";
import { test } from "node:test";

import { mapFeed, unreadCount, markAllRead, FEED_GROUP_TITLE } from "../src/assets/notifications-core.js";
// icons.js is import-safe in Node (createElementNS is only called inside lineIcon()), so we can assert
// icon-name coverage here without a DOM.
import { ICON_NAMES } from "../src/assets/icons.js";

// A couple of realistic NotificationResponse items (GET /api/v1/me/notifications, TM-454).
const REAL_ITEMS = [
  { id: 11, type: "ADMIN_MESSAGE", title: "Venue moved to Hall B", body: "See you there", createdAt: "2026-07-15T09:00:00Z", read: false },
  { id: 12, type: "EVENT_REMINDER", title: "Starts in 1 hour", body: null, createdAt: "2026-07-15T08:00:00Z", read: true },
];

// TM-745 — the whole point of the fix: the screen must NEVER render fabricated activity. These are the
// exact hardcoded strings the old buildFeed() seed shipped as if they were a real feed.
const FABRICATED_TEXTS = [
  "A spot opened up — claim it before it's gone",
  "3 new people are going",
  "Starts in 1 hour — see you there",
  "Sarah commented in the chat",
  "Welcome to Marhaba — find your first meetup",
];

test("TM-745: mapFeed does not fabricate — an empty/absent feed yields zero groups (empty state)", () => {
  assert.deepEqual(mapFeed([]), []);
  assert.deepEqual(mapFeed(null), []);
  assert.deepEqual(mapFeed(undefined), []);
  // The old seed's fabricated notifications must not appear from a no-op mapping.
  const emptyTexts = [mapFeed([]), mapFeed(null)].flatMap((f) => f.flatMap((g) => g.notes.map((n) => n.text)));
  for (const fake of FABRICATED_TEXTS) {
    assert.ok(!emptyTexts.includes(fake), `must not fabricate "${fake}"`);
  }
});

test("TM-745: mapFeed maps the REAL feed (server id/type/title/createdAt/read), never the old fake seed", () => {
  const feed = mapFeed(REAL_ITEMS);
  // One "Notifications" group holding the caller's real items — not the old per-event fake titles.
  assert.deepEqual(feed.map((g) => g.title), [FEED_GROUP_TITLE]);
  const notes = feed[0].notes;
  // Text comes from the server title (falling back to body), NOT any hardcoded copy.
  assert.deepEqual(notes.map((n) => n.text), ["Venue moved to Hall B", "Starts in 1 hour"]);
  // Server id + read flag are carried through verbatim.
  assert.deepEqual(notes.map((n) => n.id), [11, 12]);
  assert.deepEqual(notes.map((n) => n.read), [false, true]);
  // raw createdAt is passed through for the DOM half to format.
  assert.deepEqual(notes.map((n) => n.time), ["2026-07-15T09:00:00Z", "2026-07-15T08:00:00Z"]);
  // None of the fabricated seed strings can appear when mapping real data.
  const texts = notes.map((n) => n.text);
  for (const fake of FABRICATED_TEXTS) {
    assert.ok(!texts.includes(fake), `real-feed mapping must not surface "${fake}"`);
  }
});

test("mapFeed falls back title→body and is tolerant of a malformed/junk item (skipped)", () => {
  const feed = mapFeed([
    { id: 1, type: "ADMIN_MESSAGE", title: "", body: "Body only", createdAt: "2026-07-15T09:00:00Z", read: false },
    null,
    "junk",
    42,
    { id: 2, type: "EVENT_UPDATED", title: "Real title", createdAt: "2026-07-15T08:00:00Z", read: true },
  ]);
  assert.deepEqual(feed[0].notes.map((n) => n.text), ["Body only", "Real title"]);
  assert.deepEqual(feed[0].notes.map((n) => n.id), [1, 2]);
});

test("mapFeed does not mutate its input (pure)", () => {
  const items = [{ id: 1, type: "ADMIN_MESSAGE", title: "Hi", createdAt: "2026-07-15T09:00:00Z", read: false }];
  const snapshot = JSON.stringify(items);
  mapFeed(items);
  assert.equal(JSON.stringify(items), snapshot);
});

test("every mapped notification's icon resolves to a real line icon (no empty circles)", () => {
  const icons = mapFeed(REAL_ITEMS).flatMap((g) => g.notes.map((n) => n.icon));
  assert.ok(icons.length > 0);
  for (const name of icons) {
    assert.ok(ICON_NAMES.includes(name), `notification icon "${name}" must exist in icons.js ICON_NAMES`);
  }
});

test("unreadCount counts only the unread notifications", () => {
  assert.equal(unreadCount(mapFeed(REAL_ITEMS)), 1); // one unread of the two real items
  assert.equal(unreadCount(mapFeed([])), 0);
  assert.equal(unreadCount([]), 0);
  assert.equal(unreadCount(null), 0); // tolerant of junk
});

test("markAllRead clears every unread flag without mutating the input", () => {
  const before = mapFeed(REAL_ITEMS);
  const after = markAllRead(before);
  assert.equal(unreadCount(after), 0);
  // Input is untouched (pure): the original still has its 1 unread.
  assert.equal(unreadCount(before), 1);
  // New note objects, not shared references.
  assert.notEqual(after[0].notes[0], before[0].notes[0]);
});

test("markAllRead returns the SAME reference when nothing was unread (cheap no-op repaint skip)", () => {
  const allRead = markAllRead(mapFeed(REAL_ITEMS));
  assert.equal(markAllRead(allRead), allRead);
});
