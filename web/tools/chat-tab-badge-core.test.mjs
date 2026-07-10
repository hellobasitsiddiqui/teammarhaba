// Unit tests for the Chat-tab unread-badge pure core (TM-439 / TM-582) — the count + label maths
// behind the bottom-nav Chat tab's unread pill: reading the server-aggregate `total` from the
// unread-total endpoint (TM-582), the capped "9+" chip text, and the accessible "N unread" label.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, like the other cores.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  unreadTotalOf,
  decrementUnreadTotal,
  chatTabAriaLabel,
  badgeText,
  hasBadge,
  BADGE_CAP,
} from "../src/assets/chat-tab-badge-core.js";

test("unreadTotalOf: reads the aggregate `total` from the unread-total endpoint envelope", () => {
  // The server sums over ALL the caller's threads (TM-582), so this is already the whole-account total
  // — no first-page undercount. It can exceed the visible cap; the chip caps it, the a11y label doesn't.
  assert.equal(unreadTotalOf({ total: 7 }), 7);
  assert.equal(unreadTotalOf({ total: 250 }), 250);
});

test("unreadTotalOf: zero when nothing is unread", () => {
  assert.equal(unreadTotalOf({ total: 0 }), 0);
});

test("unreadTotalOf: tolerant of a missing / malformed payload (never throws, never negative)", () => {
  assert.equal(unreadTotalOf(null), 0);
  assert.equal(unreadTotalOf(undefined), 0);
  assert.equal(unreadTotalOf({}), 0); // no total field
  assert.equal(unreadTotalOf({ total: null }), 0);
  assert.equal(unreadTotalOf({ total: -4 }), 0); // negative → 0
  assert.equal(unreadTotalOf({ total: "2" }), 2); // numeric string coerces → 2
  assert.equal(unreadTotalOf({ total: "nope" }), 0); // junk → 0
  assert.equal(unreadTotalOf({ total: 1.9 }), 1); // fractional floors → 1
  assert.equal(unreadTotalOf("nope"), 0);
});

test("decrementUnreadTotal: optimistic mark-read drop subtracts a thread's unread, clamped at zero", () => {
  // Opening a thread with 3 unread out of a 10 total drops the tab total to 7 straight away (TM-585),
  // before the mark-read POST commits — no waiting for the racing server GET / the 60s poll.
  assert.equal(decrementUnreadTotal(10, 3), 7);
  assert.equal(decrementUnreadTotal(3, 3), 0); // the only unread thread → badge clears to 0
});

test("decrementUnreadTotal: never goes negative under a stale / repeated open (AC: no negative total)", () => {
  // A duplicate open (the thread already counted as read → its cached unread is 0) is a no-op, and a
  // thread whose cached unread somehow exceeds the total can't push the badge below zero.
  assert.equal(decrementUnreadTotal(2, 0), 2); // already-read reopen: unchanged
  assert.equal(decrementUnreadTotal(1, 5), 0); // over-subtract clamps at 0, never negative
  assert.equal(decrementUnreadTotal(0, 4), 0); // nothing to drop
});

test("decrementUnreadTotal: tolerant of malformed inputs (coerces to safe non-negative integers)", () => {
  assert.equal(decrementUnreadTotal(undefined, 2), 0); // no base → 0 floor, never NaN
  assert.equal(decrementUnreadTotal(9, undefined), 9); // no delta → unchanged
  assert.equal(decrementUnreadTotal(-4, 2), 0); // junk base → 0
  assert.equal(decrementUnreadTotal(8, -3), 8); // negative delta → treated as 0, never ADDS
  assert.equal(decrementUnreadTotal(8.9, 1.9), 7); // fractional inputs floor → 8 - 1 = 7
  assert.equal(decrementUnreadTotal("10", "4"), 6); // numeric strings coerce
  assert.equal(decrementUnreadTotal("nope", "nope"), 0); // total junk → 0
});

test("badgeText (re-exported): empty at zero, exact up to the cap, then '9+'", () => {
  assert.equal(BADGE_CAP, 9);
  assert.equal(badgeText(0), ""); // hidden at zero
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(9), "9"); // exactly the cap is still exact
  assert.equal(badgeText(10), "9+"); // one over the cap collapses (matches the header bell)
  assert.equal(badgeText(250), "9+");
});

test("hasBadge (re-exported): only true when there's something unread", () => {
  assert.equal(hasBadge(0), false);
  assert.equal(hasBadge(-1), false);
  assert.equal(hasBadge(1), true);
  assert.equal(hasBadge(9999), true);
});

test("chatTabAriaLabel: plain 'Chat' at zero, EXACT uncapped count otherwise", () => {
  assert.equal(chatTabAriaLabel(0), "Chat"); // natural label stands; no override
  assert.equal(chatTabAriaLabel(1), "Chat, 1 unread");
  assert.equal(chatTabAriaLabel(12), "Chat, 12 unread"); // uncapped, unlike the visible "9+" chip
  assert.equal(chatTabAriaLabel(-5), "Chat"); // junk → plain label, never throws
});

test("end-to-end: the aggregate total maps to the chip text + aria-label the DOM will paint", () => {
  // 11 unread across all the caller's threads → capped chip "9+", but the a11y label keeps the exact 11.
  const total = unreadTotalOf({ total: 11 });
  assert.equal(total, 11);
  assert.equal(hasBadge(total), true);
  assert.equal(badgeText(total), "9+");
  assert.equal(chatTabAriaLabel(total), "Chat, 11 unread");
});
