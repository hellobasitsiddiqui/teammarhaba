// Unit tests for the Chat-tab unread-badge pure core (TM-439) — the count + label maths behind the
// bottom-nav Chat tab's unread pill: summing per-thread `unreadCount` from the read API (TM-436) into
// the caller's total, the capped "9+" chip text, and the accessible "N unread" label.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, like the other cores.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  sumUnread,
  chatTabAriaLabel,
  badgeText,
  hasBadge,
  BADGE_CAP,
} from "../src/assets/chat-tab-badge-core.js";

test("sumUnread: totals each thread's unreadCount from the read-API page envelope", () => {
  const page = {
    items: [
      { id: 1, unreadCount: 2 },
      { id: 2, unreadCount: 0 },
      { id: 3, unreadCount: 5 },
    ],
    page: 0,
    size: 100,
    totalElements: 3,
  };
  assert.equal(sumUnread(page), 7);
});

test("sumUnread: also accepts a bare array of summaries (not just the envelope)", () => {
  assert.equal(sumUnread([{ unreadCount: 1 }, { unreadCount: 3 }]), 4);
  assert.equal(sumUnread([]), 0); // no threads → no unread
});

test("sumUnread: zero when every thread is read", () => {
  assert.equal(sumUnread({ items: [{ unreadCount: 0 }, { unreadCount: 0 }] }), 0);
});

test("sumUnread: tolerant of a missing / malformed payload (never throws, never negative)", () => {
  assert.equal(sumUnread(null), 0);
  assert.equal(sumUnread(undefined), 0);
  assert.equal(sumUnread({}), 0); // no items
  assert.equal(sumUnread({ items: null }), 0);
  assert.equal(sumUnread("nope"), 0);
});

test("sumUnread: junk-safe per thread — bad unreadCount contributes 0, good ones still sum", () => {
  const page = {
    items: [
      { unreadCount: 3 }, // ok
      { unreadCount: -4 }, // negative → 0
      { unreadCount: "2" }, // numeric string coerces → 2
      { unreadCount: "nope" }, // junk → 0
      { unreadCount: 1.9 }, // fractional floors → 1
      {}, // missing → 0
      null, // a null row → 0 (no throw)
    ],
  };
  assert.equal(sumUnread(page), 6); // 3 + 0 + 2 + 0 + 1 + 0 + 0
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

test("end-to-end: a page of threads maps to the chip text + aria-label the DOM will paint", () => {
  // 6 + 5 = 11 unread across two threads → capped chip "9+", but the a11y label keeps the exact 11.
  const page = { items: [{ unreadCount: 6 }, { unreadCount: 5 }] };
  const total = sumUnread(page);
  assert.equal(total, 11);
  assert.equal(hasBadge(total), true);
  assert.equal(badgeText(total), "9+");
  assert.equal(chatTabAriaLabel(total), "Chat, 11 unread");
});
