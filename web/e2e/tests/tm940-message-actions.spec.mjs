// TM-940 — the event-chat message row is cleaned up to an industry-standard (WhatsApp/Slack) layout. This
// spec guards the load-bearing INTERACTION change: reply / edit / delete are no longer a permanently-visible
// icon column — they live behind a tap-to-reveal overflow ("⋯") and must stay keyboard- + screen-reader
// reachable once revealed.
//
// DOM-BEHAVIOUR guard, MOCK-DRIVEN (no backend/Postgres), modelled on tm939-composer-announce-row.spec.mjs:
// serve.mjs (the config webServer) serves the real SPA; this spec mocks GET /api/v1/me plus the conversation
// LIST / MESSAGES / MEMBERS / READ endpoints, reveals the chat surface through the same hidden-flag seams
// router.js flips for a signed-in user, and drives window.tmChat.enterChat() onto an EVENT_GROUP thread with
// one incoming message (carrying a reaction) + one OWN message (carrying a zero-reader receipt → "Sent").
//
// Assertions (all fail on origin/main, where the actions were an always-visible column):
//   • the reply/edit/delete controls are HIDDEN by default (the menu is [hidden]; the trigger reads
//     aria-expanded=false),
//   • tapping the "⋯" trigger REVEALS them (menu visible, aria-expanded=true) and moves focus onto the first
//     action — proving they're focusable/reachable, not merely painted,
//   • each of reply / edit / delete is present, has an accessible name, and is a real focusable control,
//   • Escape re-hides the menu,
//   • the own-message receipt reads "Sent" (not "Read by none").
//
// Runs in the mobile-chromium project (Pixel 5 ≈ 393px) — the phone surface the ticket targets.

import { test, expect } from "@playwright/test";

const THREAD_ID = "7001";

const ME = {
  uid: "capture-uid",
  email: "me@example.com",
  firstName: "Aya",
  lastName: "Rahman",
  city: "London",
  age: 33,
  phone: "+44 20 7946 0958",
  role: "MEMBER",
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

// One INCOMING message (with a reaction chip) + one OWN message (carrying a zero-reader receipt → "Sent").
const MESSAGES = {
  items: [
    {
      id: "m1", senderId: "other-1", senderName: "Omar",
      body: "Are we still on for Saturday?",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      mine: false,
      reactions: [{ emoji: "👍", count: 2, mine: false }],
    },
    {
      id: "m2", senderId: "capture-uid", senderName: "Aya",
      body: "Yes! Courts booked 6pm.",
      createdAt: new Date().toISOString(), // just now → still inside the ~5-min edit window (edit shows)
      mine: true,
      readReceipt: { count: 0, readerIds: [] }, // nobody's read it → "Sent" (TM-940)
    },
  ],
  page: 0, size: 30, totalElements: 2, totalPages: 1,
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
  await expect(page.locator('[data-testid="chat-msg"]').first()).toBeVisible();
}

test.describe("@tm940 message row: tap-to-reveal actions + 'Sent' receipt", () => {
  test("reply/edit/delete are hidden until the '⋯' trigger reveals them, then reachable", async ({ page }) => {
    await mockApi(page);
    await openThread(page);

    // The OWN message (m2) is the one with edit + delete. Scope to its row.
    const ownRow = page.locator('[data-testid="chat-msg"][data-msg-id="m2"]');
    await expect(ownRow).toBeVisible();

    const trigger = ownRow.locator('[data-testid="chat-actions-trigger"]');
    const menu = ownRow.locator('[data-testid="chat-actions-menu"]');
    const reply = ownRow.locator('[data-testid="chat-reply"]');
    const edit = ownRow.locator('[data-testid="chat-edit"]');
    const del = ownRow.locator('[data-testid="chat-delete"]');

    // 1 — the trigger exists; the menu + its actions are HIDDEN by default (not a permanent icon column).
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();
    await expect(reply).toBeHidden();
    await expect(edit).toBeHidden();
    await expect(del).toBeHidden();

    // 2 — tapping the trigger REVEALS the actions and marks it expanded; focus lands on the first action
    //     (proving the revealed controls are focusable/reachable, not just painted).
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();
    await expect(reply).toBeVisible();
    await expect(edit).toBeVisible();
    await expect(del).toBeVisible();
    await expect(reply).toBeFocused(); // first action is focused on reveal

    // 3 — every action is a real, accessibly-named control (keyboard + screen-reader reachable).
    for (const [ctl, name] of [[reply, "Reply"], [edit, "Edit message"], [del, "Delete message"]]) {
      await expect(ctl).toHaveAttribute("aria-label", name);
      await expect(ctl).toBeEnabled();
    }
    // Tab from the first action reaches the next one — the revealed menu is in the tab order.
    await page.keyboard.press("Tab");
    await expect(edit).toBeFocused();

    // 4 — Escape re-hides the menu.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("reactions render as filled pill chips and the own-message receipt reads 'Sent'", async ({ page }) => {
    await mockApi(page);
    await openThread(page);

    // Reaction pill on the incoming message (m1) — a real chip, not a dashed empty oval.
    const inRow = page.locator('[data-testid="chat-msg"][data-msg-id="m1"]');
    const reactionChip = inRow.locator('[data-testid="chat-reaction"]');
    await expect(reactionChip).toBeVisible();
    await expect(reactionChip).toContainText("👍");
    await expect(reactionChip).toContainText("2");

    // The own message's receipt reads "Sent" (TM-940 — was "Read by none").
    const receipt = page.locator('[data-testid="chat-msg"][data-msg-id="m2"] [data-testid="chat-receipt"]');
    await expect(receipt).toBeVisible();
    await expect(receipt).toHaveText("Sent");
  });
});
