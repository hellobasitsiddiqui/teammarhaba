import { test, expect } from "@playwright/test";
import { EVENT_GOER } from "../fixtures.mjs";
import { expectSignedIn, signOutViaProfile } from "../helpers/auth-state.mjs";

// Sign-out state-leak guard (TM-720) — a shared-device cross-user leak: one user's persisted
// per-user state must NOT survive their sign-out, or it re-surfaces for the NEXT user who signs in
// on the same browser.
//
// This spec covers the most e2e-observable finding of the TM-720 cluster (the others are timing
// races or pure-logic guards proven by the shipped node unit tests): the FOREGROUND-PUSH INBOX
// (`localStorage["tm.notifications"]`). Before the fix, `notification-center.js` wrote to that store
// but never cleared it on sign-out — a "write-only store" — so the previous user's pushes (and their
// unread badge) stayed in localStorage and re-surfaced for the next user. The fix wires
// `onSignedOut(clearNotificationInbox)` (auth-signout.js → session-guard-core.isSignedOut), which on
// any auth change to a null user wipes the in-memory list, the localStorage store, and the badge.
//
// We drive the inbox through the SAME QA seam production/QA uses (no FCM, no native shell needed):
// `window.tmNotifications.record({...})` is the exact `pushNotificationReceived` entry point, so it
// exercises the real record → addEntry → saveEntries → localStorage path (notification-center.js).
// Then we sign out the way a real user now must (TM-906: the Profile hub's "Sign out" row + its
// confirm dialog — Firebase signOut → onAuthChanged(null)) and assert
// the store is CLEARED — the thing that would FAIL before the fix (the store survived) and PASSES
// after — and stays empty across a fresh reload (the "next user boots" boundary).
//
// Emulator-only + hermetic: same Firebase Auth emulator every other @auth spec uses; the inbox seam
// is localStorage only. We sign in as the seeded, already-onboarded EVENT_GOER (global-setup
// provisions it un-gated) so it lands straight in the app with no first-run gate to walk.

// The localStorage key the foreground-push inbox persists under (notification-inbox.js STORAGE_KEY).
const INBOX_KEY = "tm.notifications";

// Suppress the first-run product tour (TM-147) so its modal/backdrop can't overlay the sign-in /
// sign-out controls — the identical localStorage init-script every other auth spec uses.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      return typeof k === "string" && k.startsWith("tm.tour.")
        ? JSON.stringify({ done: true })
        : orig.call(this, k);
    };
  });
});

/**
 * Read the raw persisted inbox store (the leak surface). Returns the literal string "null" when the
 * key is absent (clearEntries removed it) — kept as a string so a regex assertion is always valid.
 */
async function readInboxStore(page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? "null" : raw;
  }, INBOX_KEY);
}

/** Parse the persisted inbox into an array (empty array for a null/absent/blank store). */
async function readInboxEntries(page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, INBOX_KEY);
}

test("@auth sign-out clears the foreground-push inbox so it can't leak to the next user", async ({ page }) => {
  // ── Sign in as the seeded, onboarded EVENT_GOER (real Firebase flow against the Auth emulator). ──
  // Email-code is the default front door (TM-234); the email+password form lives under "Try another
  // way" (mirrors admin-walkthrough.spec.mjs).
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", EVENT_GOER.email);
  await page.click("#try-another-btn");
  await page.fill("#password", EVENT_GOER.password);
  await page.click("#signin-btn");

  // Authenticated: the router marks body[data-auth] signed-in and the signed-out form is gone.
  await expectSignedIn(page);
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // ── Populate this user's foreground-push inbox via the QA seam (the real record path). ──────────
  // push.js is loaded on the web build and imports notification-center.js, so `window.tmNotifications`
  // exists on every page. `.record(...)` runs notifyForegroundPush → addEntry → saveEntries, writing
  // the entry to localStorage["tm.notifications"] exactly as a live foreground push would.
  await expect.poll(() => page.evaluate(() => typeof window.tmNotifications?.record)).toBe("function");
  await page.evaluate(() => {
    window.tmNotifications.record({ id: "tm720-leak-1", title: "Ride reminder", data: { route: "#/home" } });
    window.tmNotifications.record({ id: "tm720-leak-2", title: "New message", data: { route: "#/chat" } });
  });

  // Precondition: the inbox is genuinely populated + persisted (2 unread entries) — otherwise the
  // post-sign-out assertion would pass vacuously.
  const before = await readInboxEntries(page);
  expect(before).toHaveLength(2);
  expect(before.map((e) => e.title)).toEqual(["New message", "Ride reminder"]); // newest-first
  expect(before.every((e) => e.read === false)).toBe(true); // both unread — the leaking badge state

  // ── Sign out the real way (TM-906): Profile hub → "Sign out" row → styled confirm → confirm.
  // (Firebase signOut → onAuthChanged(null) → the TM-720 onSignedOut reset chain fires, unchanged.)
  await signOutViaProfile(page);
  await expect(page.locator("#auth-signed-out")).toBeVisible();

  // ── THE CRUX (TM-720): the inbox store is CLEARED on sign-out. ───────────────────────────────────
  // Before the fix, notification-center.js never cleared it on sign-out, so this store survived and
  // the previous user's pushes + unread badge re-surfaced for the next user. Poll (the clear runs in
  // the onAuthChanged callback, which resolves shortly after the button click). clearEntries removes
  // the key (or writes "[]" on a setItem-only Storage) — either way the parsed inbox is empty.
  await expect.poll(() => readInboxEntries(page)).toEqual([]);
  // And the raw store is truthfully gone (removed → null) or an explicit empty list, never the old rows.
  expect(await readInboxStore(page)).toMatch(/^(null|\[\])$/);

  // ── The leak is gone across the "next user boots" boundary too. ─────────────────────────────────
  // A fresh reload re-runs initNotificationCenter → loadEntries(localStorage). With the store cleared
  // there is nothing to hydrate, so a subsequent signed-in user starts with a genuinely empty inbox —
  // no stale entries, zero unread badge — which is the whole point of the fix.
  await page.reload();
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.tmNotifications?.refresh)).toBe("function");
  expect(await readInboxEntries(page)).toEqual([]);
});
