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
  markReadThreadUnread,
  deepLinkUnreadTopUp,
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

test("markReadThreadUnread: reads the pre-mark `unreadCount` from the MarkReadResponse (TM-855)", () => {
  // POST /conversations/{id}/read returns { conversationId, lastReadAt, unreadCount } where unreadCount
  // is the thread's server-authoritative unread at the moment it was marked read — the deep-link source.
  assert.equal(markReadThreadUnread({ conversationId: 5, lastReadAt: "2026-07-20T00:00:00Z", unreadCount: 4 }), 4);
  assert.equal(markReadThreadUnread({ unreadCount: 0 }), 0); // idempotent re-open → already read → 0
});

test("markReadThreadUnread: tolerant of a missing / malformed response (never throws, never negative)", () => {
  assert.equal(markReadThreadUnread(null), 0);
  assert.equal(markReadThreadUnread(undefined), 0);
  assert.equal(markReadThreadUnread({}), 0); // no unreadCount field
  assert.equal(markReadThreadUnread({ unreadCount: null }), 0);
  assert.equal(markReadThreadUnread({ unreadCount: -3 }), 0); // negative → 0
  assert.equal(markReadThreadUnread({ unreadCount: "6" }), 6); // numeric string coerces
  assert.equal(markReadThreadUnread({ unreadCount: 2.9 }), 2); // fractional floors
  assert.equal(markReadThreadUnread("nope"), 0);
});

test("deepLinkUnreadTopUp: deep-link open (empty cache) tops the drop up by the full pre-mark unread", () => {
  // The TM-855 bug: on a push / notification-center open state.rows is empty, so the on-open optimistic
  // drop saw cachedUnread=0 and no-op'd. The mark-read response's unreadCount is the real unread, so the
  // whole of it must be dropped once the POST resolves — the badge finally falls.
  assert.equal(deepLinkUnreadTopUp(0, { unreadCount: 3 }), 3);
  assert.equal(deepLinkUnreadTopUp(0, { unreadCount: 1 }), 1);
});

test("deepLinkUnreadTopUp: list-tap open (warm cache) is a no-op — no double-drop", () => {
  // On the list-tap path the on-open drop already subtracted the cached unread; the POST returns the same
  // authoritative count, so there is nothing left to top up (dropping again would double-count, AC: no
  // negative / no double-count under repeated open/close).
  assert.equal(deepLinkUnreadTopUp(3, { unreadCount: 3 }), 0); // cache matched authoritative exactly
  assert.equal(deepLinkUnreadTopUp(5, { unreadCount: 5 }), 0);
});

test("deepLinkUnreadTopUp: only ever tops UP — a stale-high cache never adds back or over-subtracts", () => {
  // If the cached unread was somehow HIGHER than the authoritative pre-mark count (stale row), the top-up
  // clamps at 0 — it can only add the missing delta, never re-inflate the badge the on-open drop lowered.
  assert.equal(deepLinkUnreadTopUp(5, { unreadCount: 3 }), 0); // cache over-counted → nothing to add
  assert.equal(deepLinkUnreadTopUp(2, { unreadCount: 6 }), 4); // cache under-counted → top up by the gap
});

test("deepLinkUnreadTopUp: tolerant of malformed inputs (coerces to safe non-negative integers)", () => {
  assert.equal(deepLinkUnreadTopUp(undefined, { unreadCount: 4 }), 4); // no cache base → full drop
  assert.equal(deepLinkUnreadTopUp(0, null), 0); // no response → nothing to drop, never NaN
  assert.equal(deepLinkUnreadTopUp("nope", "nope"), 0); // total junk → 0
  assert.equal(deepLinkUnreadTopUp(1.9, { unreadCount: 5.9 }), 4); // fractional floor: 5 - 1 = 4
});

test("end-to-end deep-link drop: TM-855 — a push-opened thread with unread>0 drops the badge", () => {
  // The failing scenario: deep-link open, empty list cache. On-open drop = decrementUnreadTotal(total, 0)
  // = no change (the bug). The POST resolves with unreadCount=3 → topUp = 3 → the tab total finally falls.
  const totalBefore = unreadTotalOf({ total: 8 });
  const cachedUnread = 0; // state.rows empty on a deep-link
  const onOpen = decrementUnreadTotal(totalBefore, cachedUnread);
  assert.equal(onOpen, 8, "on-open drop no-ops on a deep-link (the bug this ticket fixes)");
  const topUp = deepLinkUnreadTopUp(cachedUnread, { unreadCount: 3 });
  assert.equal(topUp, 3, "the mark-read response supplies the real unread the cache lacked");
  const totalAfter = decrementUnreadTotal(onOpen, topUp);
  assert.equal(totalAfter, 5, "the badge finally drops by the deep-linked thread's unread");
  assert.equal(badgeText(totalAfter), "5");
});

test("end-to-end list-tap drop: the warm-cache path is unchanged (drops on open, no double-drop)", () => {
  // Regression guard: the existing list-tap path must keep working exactly as before — drop on open from
  // the cache, then the POST top-up is 0 so we don't drop twice.
  const totalBefore = unreadTotalOf({ total: 8 });
  const cachedUnread = 3;
  const onOpen = decrementUnreadTotal(totalBefore, cachedUnread);
  assert.equal(onOpen, 5, "list-tap drops on open from the warm cache");
  const topUp = deepLinkUnreadTopUp(cachedUnread, { unreadCount: 3 });
  assert.equal(topUp, 0, "POST top-up is 0 on the list-tap path — no double-drop");
  assert.equal(decrementUnreadTotal(onOpen, topUp), 5, "total stays at the single drop");
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
