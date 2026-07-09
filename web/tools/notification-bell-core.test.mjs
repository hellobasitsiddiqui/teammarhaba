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
} from "../src/assets/notification-bell-core.js";

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
