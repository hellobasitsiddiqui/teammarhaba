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
import {
  conversationUnreadInList,
  collectConversationUnread,
  resolveThreadUnreadCore,
} from "../src/assets/chat-core.js";

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

test("conversationUnreadInList: reads a thread's per-caller unread from the fetched list (TM-855)", () => {
  // On a DEEP-LINK open state.rows is empty, so the thread's pre-mark unread is resolved from the
  // conversation LIST summary's server-computed `unreadCount` (fetched BEFORE the mark-read POST advances
  // the cursor — the mark-read response returns the POST-mark count, ~0, so it can't be the source).
  const items = [
    { id: 5, unreadCount: 3 },
    { id: 9, unreadCount: 0 },
    { id: 12, unreadCount: 7 },
  ];
  assert.equal(conversationUnreadInList(items, 5), 3);
  assert.equal(conversationUnreadInList(items, 12), 7);
  assert.equal(conversationUnreadInList(items, 9), 0); // already-read thread → 0
});

test("conversationUnreadInList: matches on string id (router hands a string, summaries carry a number)", () => {
  const items = [{ id: 42, unreadCount: 4 }];
  assert.equal(conversationUnreadInList(items, "42"), 4); // string id from the deep-link route
  assert.equal(conversationUnreadInList(items, 42), 4); // numeric id
});

test("conversationUnreadInList: a thread not in the fetched page → 0 (degrades, never throws)", () => {
  // A miss (thread beyond the first page, or a wrong id) yields 0: the optimistic drop no-ops and the
  // post-commit refreshChatTabBadge() reconcile still corrects the total — never worse than before.
  assert.equal(conversationUnreadInList([{ id: 1, unreadCount: 2 }], 99), 0);
  assert.equal(conversationUnreadInList([], 1), 0);
});

test("conversationUnreadInList: tolerant of malformed inputs (never throws, never negative)", () => {
  assert.equal(conversationUnreadInList(null, 1), 0);
  assert.equal(conversationUnreadInList(undefined, 1), 0);
  assert.equal(conversationUnreadInList("nope", 1), 0);
  assert.equal(conversationUnreadInList([{ id: 1 }], 1), 0); // no unreadCount field
  assert.equal(conversationUnreadInList([{ id: 1, unreadCount: null }], 1), 0);
  assert.equal(conversationUnreadInList([{ id: 1, unreadCount: -3 }], 1), 0); // negative → 0
  assert.equal(conversationUnreadInList([{ id: 1, unreadCount: "6" }], 1), 6); // numeric string coerces
  assert.equal(conversationUnreadInList([{ id: 1, unreadCount: 2.9 }], 1), 2); // fractional floors
  assert.equal(conversationUnreadInList([null, { id: 1, unreadCount: 4 }], 1), 4); // skips a null row
});

test("end-to-end deep-link drop: TM-855 — drives the REAL resolveThreadUnreadCore wiring (TM-989/B)", async () => {
  // TM-989/B: the old version of this test just re-ran the pure helpers by hand, so a full revert of the
  // TM-855 deep-link fix stayed GREEN. This now drives the ACTUAL on-open resolution seam
  // (markThreadRead → resolveThreadUnread → resolveThreadUnreadCore, the pure core chat.js delegates to):
  // deep-link open means an empty row cache, so cachedUnread is null and the core MUST fetch the list and
  // read the thread's server unread. Revert the fix (deep-link → 0 / no list lookup) and this FAILS.
  const totalBefore = unreadTotalOf({ total: 8 });
  let fetched = 0;
  const fetchPage = async (page) => {
    fetched++;
    return { items: [{ id: 5, unreadCount: 3 }], page, totalPages: 1 };
  };
  // cachedUnread = null models the deep-link cache miss the DOM layer passes in.
  const wasUnread = await resolveThreadUnreadCore(null, fetchPage, "5");
  assert.equal(fetched, 1, "deep-link open actually paged the conversation list (not the empty cache)");
  assert.equal(wasUnread, 3, "the fetched list supplies the real unread the empty cache lacked");
  const totalAfter = decrementUnreadTotal(totalBefore, wasUnread);
  assert.equal(totalAfter, 5, "the badge drops optimistically by the deep-linked thread's unread");
  assert.equal(badgeText(totalAfter), "5");
});

test("end-to-end deep-link drop: TM-989/C — a thread BEYOND page 0 is still found and drops the badge", async () => {
  // TM-855's original lookup scanned only page 0, so a chatty member whose deep-linked thread sat on a
  // later page got 0 and the drop no-oped. The pager now walks pages. Target thread id 77 lives on page 1.
  const pages = [
    { items: [{ id: 1, unreadCount: 0 }, { id: 2, unreadCount: 0 }], page: 0, totalPages: 2 },
    { items: [{ id: 77, unreadCount: 4 }], page: 1, totalPages: 2 },
  ];
  let fetched = 0;
  const fetchPage = async (page) => {
    fetched++;
    return pages[page];
  };
  const wasUnread = await resolveThreadUnreadCore(null, fetchPage, "77");
  assert.equal(fetched, 2, "it walked to page 1 to find the thread (single-page scan would stop at 1 fetch)");
  assert.equal(wasUnread, 4, "the later-page thread's real unread is resolved (single-page scan yielded 0)");
  assert.equal(decrementUnreadTotal(unreadTotalOf({ total: 10 }), wasUnread), 6);
});

test("collectConversationUnread: stops at the first page that has the thread (no over-fetching)", async () => {
  const pages = [
    { items: [{ id: 5, unreadCount: 3 }], page: 0, totalPages: 3 },
    { items: [{ id: 9, unreadCount: 9 }], page: 1, totalPages: 3 },
  ];
  let fetched = 0;
  const unread = await collectConversationUnread((page) => { fetched++; return Promise.resolve(pages[page]); }, 5);
  assert.equal(unread, 3);
  assert.equal(fetched, 1, "found on page 0 → does not fetch page 1");
});

test("collectConversationUnread: a thread that never appears degrades to 0 (best-effort)", async () => {
  const pages = [
    { items: [{ id: 1, unreadCount: 2 }], page: 0, totalPages: 2 },
    { items: [{ id: 2, unreadCount: 5 }], page: 1, totalPages: 2 },
  ];
  const unread = await collectConversationUnread((page) => Promise.resolve(pages[page]), 99);
  assert.equal(unread, 0);
});

test("end-to-end list-tap drop: the warm-cache path is unchanged — no list fetch (drives the real core)", async () => {
  // Regression guard: warm list-tap keeps working — resolveThreadUnreadCore returns the cached row's unread
  // directly with NO page fetch. If a fetch fires here the wiring regressed.
  const totalBefore = unreadTotalOf({ total: 8 });
  let fetched = 0;
  const wasUnread = await resolveThreadUnreadCore(3, async () => { fetched++; return { items: [] }; }, "5");
  assert.equal(fetched, 0, "warm cache path must not fetch the conversation list");
  assert.equal(wasUnread, 3);
  assert.equal(decrementUnreadTotal(totalBefore, wasUnread), 5, "list-tap drops on open from the warm cache");
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
