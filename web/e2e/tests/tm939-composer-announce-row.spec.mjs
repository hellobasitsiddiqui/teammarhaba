// TM-939 — the event-chat composer's "Send as announcement" toggle must sit on its OWN full-width row
// BELOW the message input, not share the input's flex row and squeeze it to a "Mes:" sliver at 390px.
//
// DOM-GEOMETRY guard, MOCK-DRIVEN (no backend/Postgres): serve.mjs (the config webServer) serves the
// real SPA; this spec mocks GET /api/v1/me (role ADMIN — the toggle is admin-only, TM-710) plus the
// conversation LIST / MESSAGES / MEMBERS / READ endpoints, then reveals the chat surface through the same
// hidden-flag seams router.js flips for a signed-in user and drives window.tmChat.enterChat() straight
// onto an EVENT_GROUP thread (typeKey "event") so maybeMountAnnounceToggle mounts the bar.
//
// The load-bearing assertion is pure layout geometry, independent of copy/theme:
//   • the announce bar and the input are on SEPARATE rows — the announce bar's bounding-box TOP is at or
//     below the input's BOTTOM (the toggle sits under the input, no vertical overlap), and
//   • the input keeps most of the composer width — its width is ≥ 70% of the composer's inner width
//     (BEFORE the fix it was roughly halved by the inline toggle → this fails on origin/main styles).
//
// Runs in the mobile-chromium project (Pixel 5 ≈ 393px) — the phone surface the bug reports.

import { test, expect } from "@playwright/test";

const THREAD_ID = "7001";

const ME = {
  uid: "capture-admin-uid",
  email: "admin@example.com",
  firstName: "Aya",
  lastName: "Rahman",
  city: "London",
  age: 33,
  phone: "+44 20 7946 0958",
  role: "ADMIN",
  enabled: true,
  accountState: { emailVerified: true, mfaEnabled: false, phoneVerified: false, photoURL: null, lastLoginAt: null },
};

const CONVERSATIONS = {
  items: [
    {
      id: THREAD_ID,
      title: "Riyadh Padel Meetup",
      type: "EVENT_GROUP",
      lastMessagePreview: "See you all on the courts!",
      lastMessageAt: new Date().toISOString(),
      unreadCount: 0,
      notificationsMuted: false,
      left: false,
    },
  ],
  page: 0, size: 20, totalElements: 1, totalPages: 1,
};

const MESSAGES = {
  items: [
    { id: "m1", senderId: "other-1", senderName: "Omar", body: "Are we still on for Saturday?", createdAt: new Date(Date.now() - 3_600_000).toISOString(), mine: false },
  ],
  page: 0, size: 30, totalElements: 1, totalPages: 1,
};

const MEMBERS = [{ id: "other-1", displayName: "Omar", firstName: "Omar", lastName: "K" }];

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page) {
  await page.route(/\/api\/v1\/.*/, (route) => json(route, { title: "Not found" }, 404)); // catch-all first
  await page.route(/\/api\/v1\/me\/conversations\/unread-total/, (route) => json(route, { total: 0 }));
  await page.route(/\/api\/v1\/me\/conversations(\?.*)?$/, (route) => json(route, CONVERSATIONS));
  await page.route(new RegExp(`/api/v1/conversations/${THREAD_ID}/messages`), (route) => json(route, MESSAGES));
  await page.route(new RegExp(`/api/v1/conversations/${THREAD_ID}/members`), (route) => json(route, MEMBERS));
  await page.route(new RegExp(`/api/v1/conversations/${THREAD_ID}/read`), (route) => json(route, { unread: 0 }));
  await page.route(/\/api\/v1\/me$/, (route) => json(route, ME));
}

async function openThread(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.tmChat, { timeout: 30_000 });
  await page.waitForTimeout(4_000); // boot splash holds ~3.2s
  await page.evaluate(() => {
    document.getElementById("boot-screen")?.remove();
    for (const elId of ["auth-signed-out", "auth-signed-in", "profile-view"]) {
      const el = document.getElementById(elId);
      if (el) el.hidden = true;
    }
    const view = document.getElementById("chat-view");
    if (view) view.hidden = false;
    document.body.classList.add("tm-has-tabbar");
    window.tmChat.enterChat(); // render LIST → populate state.rows (thread resolves typeKey "event")
  });
  await page.waitForTimeout(800);
  await page.evaluate((id) => window.tmChat.enterChat(id), THREAD_ID);
  await expect(page.locator('[data-testid="chat-composer"]')).toBeVisible();
  // the announce bar mounts async once the ADMIN flag resolves
  await expect(page.locator('[data-testid="chat-announce-toggle"]')).toBeAttached();
}

test("announce toggle sits on its own row below a full-width input (390px)", async ({ page }) => {
  await mockApi(page);
  await openThread(page);

  const composerBox = await page.locator('[data-testid="chat-composer"]').boundingBox();
  const announceBox = await page.locator('[data-testid="chat-announce-bar"]').boundingBox();
  const inputBox = await page.locator('input.tm-chat-input, .tm-chat-input').first().boundingBox();

  expect(composerBox, "composer must be laid out").not.toBeNull();
  expect(announceBox, "announce bar must be laid out").not.toBeNull();
  expect(inputBox, "input must be laid out").not.toBeNull();

  // 1 — separate rows: the announce bar starts at or below the input's bottom (toggle sits UNDER the
  //     input, no vertical overlap). A tiny sub-pixel fudge (1px) absorbs rounding; the real BEFORE
  //     overlap (inline toggle sharing the input's row) is tens of px.
  expect(
    announceBox.y,
    `announce bar top (${announceBox.y}) must be at/below the input bottom (${inputBox.y + inputBox.height})`,
  ).toBeGreaterThanOrEqual(inputBox.y + inputBox.height - 1);

  // 2 — the input keeps most of the composer's width (BEFORE the fix the inline toggle roughly halved it).
  const ratio = inputBox.width / composerBox.width;
  expect(ratio, `input width ratio ${ratio.toFixed(2)} must be ≥ 0.70 of the composer`).toBeGreaterThanOrEqual(0.7);

  await page.locator('[data-testid="chat-composer"]').screenshot({ path: "test-results/tm939-composer.png" });
});
