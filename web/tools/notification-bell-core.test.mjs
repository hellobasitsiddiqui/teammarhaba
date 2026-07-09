// Unit tests for the notification-bell pure core (TM-455) — the header bell's unread badge maths:
// the total-unread sum, the "9+" chip text + cap, the accessible label, and the show/hide gate.
//
// Framework-free — Node's built-in test runner, picked up by the CI glob
// `node --test web/tools/*.test.mjs` (ci.yml web-build job). No DOM/Firebase, like the other cores.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BADGE_CAP,
  badgeTotal,
  badgeText,
  hasBadge,
  bellAriaLabel,
  shouldShowBell,
  createBadgeSync,
} from "../src/assets/notification-bell-core.js";

/** A promise plus its resolve/reject, so a test can hold a fetch "in flight" and resolve it on cue. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("badgeTotal: the admin/system unseen count is the bell total (chat half not yet wired)", () => {
  assert.equal(badgeTotal({ unseen: 3, unread: 5 }), 3); // unseen is the badge, NOT unread
  assert.equal(badgeTotal({ unseen: 0, unread: 9 }), 0); // seen everything → no badge even if unread
  assert.equal(badgeTotal({ unseen: 12 }), 12); // unread may be absent
});

test("badgeTotal: sums the chat-unread half in when a caller passes it (forward-compatible)", () => {
  assert.equal(badgeTotal({ unseen: 2 }, 3), 5);
  assert.equal(badgeTotal({ unseen: 0 }, 4), 4);
  assert.equal(badgeTotal(null, 6), 6); // no admin/system payload, chat-only
});

test("badgeTotal: tolerant of a missing / malformed payload (never throws, never negative)", () => {
  assert.equal(badgeTotal(null), 0);
  assert.equal(badgeTotal(undefined), 0);
  assert.equal(badgeTotal({}), 0);
  assert.equal(badgeTotal({ unseen: -4 }), 0); // negatives floor to 0
  assert.equal(badgeTotal({ unseen: "7" }), 7); // numeric string coerces
  assert.equal(badgeTotal({ unseen: "nope" }), 0); // junk → 0
  assert.equal(badgeTotal({ unseen: 2.9 }), 2); // fractional floors
  assert.equal(badgeTotal({ unseen: 2 }, -1), 2); // negative chat count ignored
});

test("badgeText: empty at zero, exact up to the cap, then '9+'", () => {
  assert.equal(BADGE_CAP, 9);
  assert.equal(badgeText(0), ""); // hidden at zero
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(9), "9"); // exactly the cap is still exact
  assert.equal(badgeText(10), "9+"); // one over the cap collapses
  assert.equal(badgeText(250), "9+");
});

test("badgeText: honours a custom cap and stays junk-safe", () => {
  assert.equal(badgeText(99, 99), "99");
  assert.equal(badgeText(100, 99), "99+");
  assert.equal(badgeText(-3), ""); // negative → empty (nothing to show)
  assert.equal(badgeText(NaN), "");
  assert.equal(badgeText("4"), "4");
});

test("hasBadge: only true when there's something unread", () => {
  assert.equal(hasBadge(0), false);
  assert.equal(hasBadge(-1), false);
  assert.equal(hasBadge(1), true);
  assert.equal(hasBadge(9999), true);
});

test("bellAriaLabel: announces the EXACT uncapped count (screen readers hear '12 unread', not '9+')", () => {
  assert.equal(bellAriaLabel(0), "Notifications");
  assert.equal(bellAriaLabel(1), "Notifications, 1 unread");
  assert.equal(bellAriaLabel(12), "Notifications, 12 unread"); // uncapped, unlike the visible chip
  assert.equal(bellAriaLabel(-5), "Notifications"); // junk → plain label
});

test("shouldShowBell: signed-in + un-gated only (same gate as the tab bar)", () => {
  assert.equal(shouldShowBell({ signedIn: true, gated: false }), true);
  assert.equal(shouldShowBell({ signedIn: true, gated: true }), false); // on onboarding/terms gate
  assert.equal(shouldShowBell({ signedIn: false, gated: false }), false); // signed out
  assert.equal(shouldShowBell({ signedIn: false, gated: true }), false);
  assert.equal(shouldShowBell({}), false); // missing flags → hidden
  assert.equal(shouldShowBell(), false); // no arg → hidden, never throws
});

// --- createBadgeSync: the TM-556 mark-seen-vs-refresh race guard -----------------------------------

test("createBadgeSync: THE RACE — a stale in-flight refresh must NOT repaint over a mark-seen", async () => {
  const painted = [];
  const fetchGate = deferred(); // hold the refresh GET "in flight" with the pre-seen count
  const sync = createBadgeSync({
    fetchBadge: () => fetchGate.promise,
    markSeen: async () => ({ unseen: 0 }), // opening the bell clears the badge
    paint: (badge) => painted.push(badgeTotal(badge)),
  });

  // 1) A refresh() GET is already in flight (the 60s poll / route render) carrying the PRE-seen count.
  const refreshing = sync.refresh();

  // 2) The user clicks the bell: mark-seen supersedes the in-flight refresh and paints 0.
  await sync.markSeenAndPaint();
  assert.deepEqual(painted, [0]); // badge cleared

  // 3) NOW the stale GET resolves with the pre-seen N=7 — it must be DROPPED, not painted.
  fetchGate.resolve({ unseen: 7 });
  await refreshing;

  assert.deepEqual(painted, [0]); // still only the mark-seen paint; the stale 7 was ignored
});

test("createBadgeSync: a refresh with no intervening mark-seen paints its result as normal", async () => {
  const painted = [];
  const sync = createBadgeSync({
    fetchBadge: async () => ({ unseen: 4 }),
    markSeen: async () => ({ unseen: 0 }),
    paint: (badge) => painted.push(badgeTotal(badge)),
  });

  await sync.refresh();
  assert.deepEqual(painted, [4]); // no supersede happened, so the fresh count paints
});

test("createBadgeSync: overlapping refreshes dedupe — only one GET is in flight at a time", async () => {
  let calls = 0;
  const gate = deferred();
  const sync = createBadgeSync({
    fetchBadge: () => {
      calls += 1;
      return gate.promise;
    },
    markSeen: async () => ({ unseen: 0 }),
    paint: () => {},
  });

  const a = sync.refresh();
  const b = sync.refresh(); // swallowed by the in-flight latch — must NOT fire a second GET
  gate.resolve({ unseen: 1 });
  await Promise.all([a, b]);

  assert.equal(calls, 1);
});

test("createBadgeSync: after mark-seen a corrective refresh still runs (not swallowed by the stale latch)", async () => {
  const painted = [];
  const staleGate = deferred();
  let fetchCalls = 0;
  const sync = createBadgeSync({
    fetchBadge: () => {
      fetchCalls += 1;
      // GET #1 = the stale in-flight refresh (held open); later GETs resolve immediately with a fresh 2.
      return fetchCalls === 1 ? staleGate.promise : Promise.resolve({ unseen: 2 });
    },
    markSeen: async () => ({ unseen: 0 }),
    paint: (badge) => painted.push(badgeTotal(badge)),
  });

  const stale = sync.refresh(); // GET #1 in flight (pre-seen count)
  await sync.markSeenAndPaint(); // supersede + paint 0, release the latch the stale GET held
  await sync.refresh(); // corrective refresh MUST run now → fresh count 2
  staleGate.resolve({ unseen: 7 }); // stale GET #1 resolves late → dropped
  await stale;

  assert.equal(fetchCalls, 2); // the corrective refresh actually fired (the latch didn't swallow it)
  assert.deepEqual(painted, [0, 2]); // cleared, then reconciled to the fresh 2; the stale 7 dropped
});

test("createBadgeSync: supersede() on sign-out drops an in-flight refresh's result", async () => {
  const painted = [];
  const fetchGate = deferred();
  const sync = createBadgeSync({
    fetchBadge: () => fetchGate.promise,
    markSeen: async () => ({ unseen: 0 }),
    paint: (badge) => painted.push(badgeTotal(badge)),
  });

  const refreshing = sync.refresh(); // in flight with some count
  sync.supersede(); // signed out / re-gated
  fetchGate.resolve({ unseen: 5 }); // resolves after sign-out → must be dropped
  await refreshing;

  assert.deepEqual(painted, []); // nothing painted: the stale post-sign-out result was ignored
});

test("createBadgeSync: never throws on a failing fetch/mark-seen — routes to onError", async () => {
  const errors = [];
  const sync = createBadgeSync({
    fetchBadge: async () => {
      throw new Error("offline");
    },
    markSeen: async () => {
      throw new Error("500");
    },
    paint: () => assert.fail("must not paint on error"),
    onError: (label, err) => errors.push([label, err.message]),
  });

  await sync.refresh();
  await sync.markSeenAndPaint();

  assert.deepEqual(errors, [
    ["refresh", "offline"],
    ["mark-seen", "500"],
  ]);
});
