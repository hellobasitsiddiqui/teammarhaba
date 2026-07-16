// In-thread chat search — LIVE seeded behaviour (TM-690, rich-chat v1).
//
// TM-690 adds a client-side, WITHIN-THREAD search: a "Search" toggle in the loaded thread's header
// reveals a panel that filters THIS thread's already-loaded messages (chat-search-core) and lists the
// hits with the match highlighted; tapping a result jumps to it (scrollToMessage's flash). The pure
// match/highlight/snippet core is unit-tested (web/tools/chat-search-core.test.mjs); this spec gives the
// DOM half real behavioural coverage — the thing that would FAIL before the fix (no toggle, no panel,
// no filtered results, no jump) and PASS after.
//
// It MIRRORS chat-foundation.spec.mjs exactly: same tour-suppression beforeEach, the same per-spec
// email+password signIn helper, the same CHAT_SEED account seeded via the profile-gated seed endpoint
// (POST /api/v1/test/chat/seed, chat-seed.mjs), and the same mobile-chromium (Pixel 5) surface. No new
// seed endpoint, no new fixture account, no shared-file change — it reuses the "Sunday Morning Dog Walk"
// thread ChatSeedService already populates (one system "You joined …" notice + seven human messages).
//
// The load-bearing assertions target the specific fixed behaviour of chat-search-core.messageMatches:
//   • "gate" → EXACTLY the two human messages that contain it ("North gate, 9am …" + "See you all at
//     the north gate at 9!") — a "2 matches" count, both rows real jumpable content.
//   • "walk" → EXACTLY ONE result even though the SYSTEM notice "You joined Sunday Morning Dog Walk"
//     ALSO contains "walk" — proving system notices (no data-msg-id anchor, m.system) are excluded.
//   • tapping a result closes the panel and JUMPS to the message: the target chat-msg row (matched by
//     its data-msg-id) gains the transient tm-chat-msg--flash class (scrollToMessage).
//   • a no-hit query renders the "No messages found." empty state, not a stale result list.

import { test, expect } from "@playwright/test";
import { CHAT_SEED } from "../fixtures.mjs";
import { seedChat } from "../chat-seed.mjs";

// The Chat section is entered via the bottom tab bar (#tab-chat), which the CSS only reveals at a phone
// width (`@media (max-width: 33rem)` ≈ 528px — desktop keeps it `display:none`). The sibling chat specs
// get that width from the config's mobile-chromium project; rather than touch that shared config's
// testMatch allowlist, this spec runs under the default (desktop) project but PINS a Pixel-5-width
// viewport itself, so the tab bar is present. Self-contained — no shared-file change.
test.use({ viewport: { width: 393, height: 851 } });

// Suppress the first-run product tour (TM-147) so its dimmed backdrop can't cover the chat surface —
// the identical localStorage init-script every other chat spec uses (seeded accounts look "first-run"
// each run since the emulator wipes their localStorage).
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
 *  chat-foundation.spec.mjs / events.spec.mjs use. The account is provisioned onboarded + terms-accepted
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

test.describe("@chat-search in-thread search filters, excludes system notices, and jumps (TM-690)", () => {
  test("search a loaded thread: token filter + count, system-notice exclusion, jump-to-result, empty state", async ({
    page,
  }, testInfo) => {
    const shot = stepShot(page, testInfo, "chat-search");

    // Seed the account's chat via the real endpoint BEFORE we read it — the "Sunday Morning Dog Walk"
    // thread (thread A) carries one system "You joined …" notice + seven human messages. Idempotent, so
    // a CI retry re-uses the same seeded threads rather than piling up duplicates.
    const seeded = await seedChat(CHAT_SEED);
    expect(seeded.eventThreads).toBe(2);

    await signIn(page, CHAT_SEED);

    // Open the seeded event thread that search operates over.
    await page.locator("#tab-chat").click();
    await expect(page.locator("#chat-view")).toBeVisible();
    await page.locator('[data-testid="chat-row"]', { hasText: "Sunday Morning Dog Walk" }).click();
    await expect(page.locator('[data-testid="chat-thread"]')).toBeVisible();

    // Baseline: seven real message rows (chat-msg) + the "You joined …" system notice (chat-system).
    // The system notice is NOT a chat-msg — it's the row search must exclude below.
    const messages = page.locator('[data-testid="chat-msg"]');
    await expect(messages).toHaveCount(7);
    await expect(page.locator('[data-testid="chat-system"]').first()).toBeVisible();

    // The search panel starts collapsed; its toggle lives in the thread header actions (TM-690).
    const toggle = page.locator('[data-testid="chat-search-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const panel = page.locator('[data-testid="chat-search"]');
    await expect(panel).toBeHidden();
    await shot("thread-open");

    // Open search — the panel + input reveal, toggle flips aria-expanded.
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const input = page.locator('[data-testid="chat-search-input"]');
    await expect(input).toBeVisible();

    const results = page.locator('[data-testid="chat-search-results"]');
    const resultButtons = results.locator(".tm-chat-search-result");
    const count = page.locator('[data-testid="chat-search-count"]');

    // 1) "gate" → EXACTLY the two human messages containing it ("North gate, 9am …" + "the north gate
    //    at 9!"). Proves the client-side token filter over thread.messages, and the pluralised count.
    await input.fill("gate");
    await expect(count).toHaveText("2 matches");
    await expect(resultButtons).toHaveCount(2);
    // Each hit's snippet highlights the matched token in a <mark> (highlightSegments), never as markup.
    await expect(results.locator("mark").first()).toBeVisible();
    await expect(results.locator("mark").first()).toHaveText(/gate/i);
    await shot("results-gate");

    // 2) "walk" → EXACTLY ONE result even though the SYSTEM notice "You joined Sunday Morning Dog Walk"
    //    also contains "walk". This is the load-bearing exclusion: a naive filter over ALL rendered
    //    text would return 2. chat-search-core.messageMatches drops system/pending/id-less rows, so the
    //    only hit is the human "…perfect for a walk ☀️" message.
    await input.fill("walk");
    await expect(count).toHaveText("1 match");
    await expect(resultButtons).toHaveCount(1);
    await expect(resultButtons.first()).toContainText("perfect for a walk");
    await shot("results-walk-excludes-system");

    // 3) Tapping a result CLOSES the panel and JUMPS to that message: the target chat-msg row (found by
    //    its data-msg-id) gains the transient tm-chat-msg--flash class (scrollToMessage). This is the
    //    end-to-end "search → jump" behaviour, not just that a list rendered.
    await resultButtons.first().click();
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The flashed message is a real chat-msg carrying the "…perfect for a walk" body.
    const flashed = page.locator('[data-testid="chat-msg"].tm-chat-msg--flash');
    await expect(flashed).toHaveCount(1);
    await expect(flashed).toContainText("perfect for a walk");
    await shot("jumped-to-result");

    // 4) A query with no hit renders the "No messages found." empty state — not a stale result list.
    await toggle.click();
    await expect(panel).toBeVisible();
    await input.fill("zzzznotarealmessage");
    await expect(results.locator(".tm-chat-search-empty")).toHaveText("No messages found.");
    await expect(resultButtons).toHaveCount(0);
    await expect(count).toHaveText("");
    await shot("results-none");
  });
});
