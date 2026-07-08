// Unit tests for the Notifications feed pure core (TM-515) — the seed feed, unread count, and the
// immutable mark-all-read.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, like the other cores.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFeed, unreadCount, markAllRead } from "../src/assets/notifications-core.js";
// icons.js is import-safe in Node (createElementNS is only called inside lineIcon()), so we can assert
// icon-name coverage here without a DOM.
import { ICON_NAMES } from "../src/assets/icons.js";

test("buildFeed reproduces the paper-notifications wireframe: groups, order and the 5 note types", () => {
  const feed = buildFeed();
  assert.deepEqual(
    feed.map((g) => g.title),
    ["Sunday Morning Dog Walk", "Coffee & Code Meetup", "General"],
  );
  const texts = feed.flatMap((g) => g.notes.map((n) => n.text));
  assert.deepEqual(texts, [
    "A spot opened up — claim it before it's gone",
    "3 new people are going",
    "Starts in 1 hour — see you there",
    "Sarah commented in the chat",
    "Welcome to Marhaba — find your first meetup",
  ]);
  // The wireframe's read/unread pattern: first three unread, last two read.
  assert.deepEqual(
    feed.flatMap((g) => g.notes.map((n) => n.read)),
    [false, false, false, true, true],
  );
});

test("buildFeed is a fresh copy each call (a caller can mark-all-read without poisoning the seed)", () => {
  const a = buildFeed();
  const b = buildFeed();
  assert.notEqual(a, b);
  assert.notEqual(a[0].notes[0], b[0].notes[0]);
  markAllRead(a); // pure — returns a new list; even so, mutating `a` here must not touch `b`
  a[0].notes[0].read = true;
  assert.equal(b[0].notes[0].read, false);
});

test("unreadCount counts only the unread notifications", () => {
  assert.equal(unreadCount(buildFeed()), 3);
  assert.equal(unreadCount([]), 0);
  assert.equal(unreadCount(null), 0); // tolerant of junk
});

test("markAllRead clears every unread flag without mutating the input", () => {
  const before = buildFeed();
  const after = markAllRead(before);
  assert.equal(unreadCount(after), 0);
  // Input is untouched (pure): the original still has its 3 unread.
  assert.equal(unreadCount(before), 3);
  // New note objects, not shared references.
  assert.notEqual(after[0].notes[0], before[0].notes[0]);
});

test("markAllRead returns the SAME reference when nothing was unread (cheap no-op repaint skip)", () => {
  const allRead = markAllRead(buildFeed());
  assert.equal(markAllRead(allRead), allRead);
});

test("every notification's icon name resolves to a real line icon (no empty circles)", () => {
  const icons = buildFeed().flatMap((g) => g.notes.map((n) => n.icon));
  for (const name of icons) {
    assert.ok(ICON_NAMES.includes(name), `notification icon "${name}" must exist in icons.js ICON_NAMES`);
  }
});
