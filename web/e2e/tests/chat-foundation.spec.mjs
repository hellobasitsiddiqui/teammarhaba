// Chat foundation — LIVE seeded evidence (TM-587).
//
// The Event Chat foundation visual evidence (TM-564) could only show the EMPTY conversation list
// against a live backend — there was no way to seed conversations + messages for a test user, so the
// populated list / thread / unread-badge shots were rendered against ROUTE MOCKS. TM-587 adds a
// profile-gated, non-prod-only seed endpoint (POST /api/v1/test/chat/seed); this spec uses it to
// render + assert the populated chat foundation screens against a LIVE backend + Postgres — no mocks.
//
// It runs at the phone viewport (the mobile-chromium project, Pixel 5 — the same surface TM-564's
// capture harness used), signs in as the seeded CHAT_SEED account, seeds its chat via the endpoint,
// then asserts the three foundation surfaces the evidence needs — the populated conversation list
// (event chats + an admin "from TeamMarhaba" channel, per-row unread pills), an open thread (real
// messages + a system notice), and the unread Chat-tab badge — each with a named screenshot (on top of
// the global screenshot:"on") so the run yields a step-by-step visual trail to attach to TM-564.

import { test, expect } from "@playwright/test";
import { CHAT_SEED } from "../fixtures.mjs";
import { seedChat } from "../chat-seed.mjs";

// Suppress the first-run product tour (TM-147) so its dimmed backdrop can't cover the chat surface —
// the identical localStorage init-script every other spec uses (seeded accounts look "first-run" each
// run since the emulator wipes their localStorage).
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

/** Sign in a seeded, un-gated account via the email+password ("Try another way") flow — the same path
 *  events.spec.mjs / broadcast-admin.spec.mjs use. The account is provisioned onboarded + terms-accepted
 *  in global-setup, so it lands straight in the app (no first-run gate). */
async function signIn(page, account) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await expect(page.locator("#auth-signed-in")).toBeVisible();
}

/** A named step-screenshot helper (on top of the global screenshot:"on") — a step-by-step trail. */
function stepShot(page, testInfo, prefix) {
  let n = 0;
  return (name) =>
    page.screenshot({
      path: testInfo.outputPath(`${prefix}-${String(++n).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });
}

test.describe("@chat-foundation the seeded chat renders live (TM-587)", () => {
  test("populated list, an open thread, and the unread Chat-tab badge — all from a live backend", async ({
    page,
  }, testInfo) => {
    const shot = stepShot(page, testInfo, "chat-foundation");

    // Seed the account's chat via the real endpoint BEFORE we read it — two event group threads + an
    // admin "from TeamMarhaba" channel, with messages + unread state. Idempotent, so a CI retry re-uses
    // the same seeded threads rather than piling up duplicates.
    const seeded = await seedChat(CHAT_SEED);
    expect(seeded.eventThreads).toBe(2);
    expect(seeded.adminThreads).toBe(1);
    expect(seeded.unreadTotal).toBe(10);

    await signIn(page, CHAT_SEED);

    // 1) Populated LIST + the unread Chat-tab BADGE — open Chat and assert real, seeded rows render
    // (not the empty state, not a mock): three rows with the derived event/admin titles. The Chat-tab
    // badge paints the server aggregate total (10 → the capped "9+", TM-439/TM-582). Both are asserted
    // BEFORE any thread is opened, since opening one marks it read and decrements the total live.
    await page.locator("#tab-chat").click();
    await expect(page.locator("#chat-view")).toBeVisible();
    await expect(page.locator('[data-testid="chat-list"]')).toBeVisible();
    const rows = page.locator('[data-testid="chat-row"]');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('[data-testid="chat-row"]', { hasText: "Sunday Morning Dog Walk" })).toBeVisible();
    await expect(page.locator('[data-testid="chat-row"]', { hasText: "Riverside 5k Run Club" })).toBeVisible();
    await expect(page.locator('[data-testid="chat-row"]', { hasText: "TeamMarhaba" })).toBeVisible();

    const badge = page.locator("#tab-chat-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("9+");
    await shot("list-populated-and-badge");

    // 2) Open the event THREAD — its real messages render, including the "You joined …" system notice.
    await page.locator('[data-testid="chat-row"]', { hasText: "Sunday Morning Dog Walk" }).click();
    await expect(page.locator('[data-testid="chat-thread"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-system"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="chat-msg"]').first()).toBeVisible();
    // The composer is the member thread chrome (TM-448) — proves this is the real, live thread view.
    await expect(page.locator('[data-testid="chat-composer"]')).toBeVisible();
    await shot("thread-event");
  });
});
