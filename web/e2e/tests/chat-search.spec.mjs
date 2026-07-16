// In-thread chat search — LIVE seeded behaviour (TM-690, rich-chat v1).
//
// TM-690 adds a client-side, WITHIN-THREAD search: a "Search" toggle in the loaded thread's header
// reveals a panel that filters THIS thread's already-loaded messages (chat-search-core) and lists the
// hits with the match highlighted; tapping a result jumps to it (scrollToMessage's flash). The pure
// match/highlight/snippet core is unit-tested (web/tools/chat-search-core.test.mjs); this spec gives the
// DOM half real behavioural coverage — the thing that would FAIL before the fix (no toggle, no panel,
// no filtered results, no jump) and PASS after.
//
// It MIRRORS chat-foundation.spec.mjs's shape: same tour-suppression beforeEach, the same per-spec
// email+password signIn helper, the profile-gated seed endpoint (POST /api/v1/test/chat/seed,
// chat-seed.mjs) that populates the "Sunday Morning Dog Walk" thread (one system "You joined …" notice
// + seven human messages), and the same mobile-chromium (Pixel 5) surface.
//
// ISOLATION (the CI-run-29499146715 fix): it does NOT reuse the shared CHAT_SEED fixture account.
// chat-foundation.spec.mjs asserts CHAT_SEED's server-side unread total is exactly 10 (its Chat-tab
// badge evidence) — but opening the "Sunday Morning Dog Walk" thread here marks its messages read and
// drops that account's unread count, and the seed endpoint is idempotent (a re-seed no-ops), so it can
// never be restored. That cross-spec state bleed is what red chat-foundation. So this spec seeds + drives
// a FRESH, per-run account it OWNS (created in-spec via the emulator's accounts:signUp, un-gated through
// the same public-API sequence global-setup.provisionInBackend uses — the exact pattern
// payment-webhook-safety.spec.mjs already uses), which gets its OWN private copy of the same threads
// (ChatSeedService keys every thread + the unread state on the CALLER's id, so seeding here touches only
// this account). Marking its thread read can't reduce CHAT_SEED's total. Still no new fixture account and
// no shared-file change — the account is created + owned entirely inside this spec.
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
import { AUTH_EMULATOR_HOST, API_BASE_URL } from "../fixtures.mjs";
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

/** Sign in an un-gated account via the email+password ("Try another way") flow — the same path
 *  chat-foundation.spec.mjs / events.spec.mjs use. The account must be onboarded + terms-accepted (the
 *  fresh account below is, via createFreshUngatedAccount), so it lands straight in the app (no gate). */
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

/**
 * Create a FRESH, per-run emulator account that THIS spec owns, so seeding + reading its chat can never
 * touch the shared CHAT_SEED fixture chat-foundation.spec.mjs asserts on (the isolation fix — see the
 * file header). Same technique payment-webhook-safety.spec.mjs uses: sign it up via the Auth emulator's
 * own accounts:signUp REST endpoint (unique email keyed on Date.now()), then un-gate it through the exact
 * public-API sequence global-setup.provisionInBackend runs (GET /me → POST /me/onboarding-complete →
 * POST /me/accept-terms), replicated inline so no shared helper / fixture / global-setup is touched.
 * Returns the account creds (email + password) for the browser sign-in AND seedChat (which mints its own
 * token from them).
 */
async function createFreshUngatedAccount() {
  const email = `e2e-chat-search-${Date.now()}@teammarhaba.test`;
  const password = "e2e-chat-search-pw-123456";

  // 1) Create the account in the Auth emulator (returnSecureToken → we get an ID token straight back).
  const signUpUrl =
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
  const signUpRes = await fetch(signUpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!signUpRes.ok) {
    throw new Error(`emulator signUp failed for ${email}: ${signUpRes.status} ${await signUpRes.text()}`);
  }
  const { idToken } = await signUpRes.json();
  const authed = { Authorization: `Bearer ${idToken}`, Accept: "application/json" };

  // 2) Provision the backend users row (JIT via GET /me), and read the current terms version to accept.
  const meRes = await fetch(`${API_BASE_URL}/api/v1/me`, { headers: authed });
  if (!meRes.ok) throw new Error(`provision (GET /me) failed for ${email}: ${meRes.status} ${await meRes.text()}`);
  const currentTermsVersion = (await meRes.json()).currentTermsVersion;

  // 3) Clear the first-run onboarding gate (TM-250) so the browser sign-in lands straight in the app.
  const onboardRes = await fetch(`${API_BASE_URL}/api/v1/me/onboarding-complete`, { method: "POST", headers: authed });
  if (!onboardRes.ok) {
    throw new Error(`onboarding-complete failed for ${email}: ${onboardRes.status} ${await onboardRes.text()}`);
  }

  // 4) Accept the current terms version (TM-170) so the terms gate is cleared too.
  if (currentTermsVersion) {
    const termsRes = await fetch(`${API_BASE_URL}/api/v1/me/accept-terms`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ version: currentTermsVersion }),
    });
    if (!termsRes.ok) throw new Error(`accept-terms failed for ${email}: ${termsRes.status} ${await termsRes.text()}`);
  }

  return { email, password };
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

    // ISOLATION: create + own a FRESH account (never the shared CHAT_SEED fixture — see the file header),
    // so seeding + reading its chat here can't drop CHAT_SEED's unread total that chat-foundation asserts.
    const account = await createFreshUngatedAccount();

    // Seed THIS account's chat via the real endpoint BEFORE we read it — it gets its OWN private copy of
    // the "Sunday Morning Dog Walk" thread (thread A: one system "You joined …" notice + seven human
    // messages), since ChatSeedService keys every thread on the caller's id. A brand-new account is never
    // already-seeded, so this always populates fresh.
    const seeded = await seedChat(account);
    expect(seeded.eventThreads).toBe(2);

    await signIn(page, account);

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
