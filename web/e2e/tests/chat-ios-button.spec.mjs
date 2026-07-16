import { test, expect } from "@playwright/test";
import { CHAT_SEED } from "../fixtures.mjs";

// iOS "Coming soon" app badge — tap feedback on the Chat screen (TM-657).
//
// The reporter hit this on the Chat screen: the "Get the app" footer's iOS badge showed
// "Coming soon" but a tap did NOTHING — it was a real `<button disabled>`, and a disabled button
// emits no click, so the tap was a silent dead no-op that reads as broken. (The Android badge next to
// it — a real /download link — works, which made the iOS one look extra broken by comparison.)
//
// The "Get the app" badges (TM-276) are a single static footer block in index.html (id
// #app-store-badges) that footer.js does NOT scope away in-app — so it's present on EVERY signed-in
// screen, including Chat. app-badges.js (TM-657) now, on mobile-web / desktop (i.e. NOT inside the
// native WebView), un-disables the iOS badge so it can answer a tap, keeps it announced unavailable
// (aria-disabled="true" + the dimmed .store-badge-disabled look, so it never reads as a live
// download), and on click preventDefaults + shows an honest "coming soon" toast instead of silence.
//
// This spec drives the exact surface the ticket names — it signs in, opens the Chat screen, and taps
// the iOS badge in that screen's footer. The load-bearing assertion is the one that FAILS before the
// fix and PASSES after: the badge is no longer `disabled` and a tap produces the honest toast (a
// disabled button would emit no click and no toast at all). It rides the existing main + manual
// -dispatch e2e workflow (never the PR gate), like its siblings.
//
// CHAT_SEED is a seeded, un-gated account (provisioned onboarded + terms-accepted in global-setup), so
// it lands straight in the app with no first-run gate to walk. We don't seed its chat — this test only
// needs to REACH the Chat screen, not populate it — so no seed endpoint / shared change is required.

// The exact copy the fix toasts on tap (app-badges.js) — asserting the string, not just "a toast",
// proves the honest "iOS isn't out yet, get Android for now" message, not some other feedback.
const IOS_TOAST_TEXT = "The iOS app isn't out yet — coming soon. Grab the Android app for now.";

// Suppress the first-run product tour (TM-147) so its dimmed backdrop can't overlay the footer badge —
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
 *  chat-foundation.spec.mjs / events.spec.mjs use. The account is provisioned onboarded + terms
 *  -accepted in global-setup, so it lands straight in the app (no first-run gate). */
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

test.describe('@ios-badge Chat screen iOS "Coming soon" badge answers a tap (TM-657)', () => {
  test('the Chat screen iOS badge is tappable and toasts "coming soon" instead of doing nothing', async ({
    page,
  }) => {
    await signIn(page, CHAT_SEED);

    // Open the Chat screen — the exact surface the ticket names. Navigate straight to the (protected)
    // #/chat route the same way chat-live-stream.spec.mjs does — viewport-independent, so it works under
    // this spec's DESKTOP chromium project (the bottom #tab-chat nav is a mobile-width-only control). The
    // "Get the app" footer (and its iOS badge) is a global block footer.js does NOT scope away in-app, so
    // it's present on this screen.
    await page.goto("/#/chat");
    await expect(page.locator("#chat-view")).toBeVisible();
    await expect(page).toHaveURL(/#\/chat$/);

    // The iOS badge (accessible name "iOS app coming soon"). It's the disabled-looking placeholder in
    // the footer's "Get the app" row — still announced unavailable, still dimmed.
    const ios = page.getByRole("button", { name: "iOS app coming soon" });
    await expect(ios).toBeVisible();
    await expect(ios).toContainText("Coming soon");

    // AC — it's still announced UNAVAILABLE to assistive tech (aria-disabled) and keeps its dimmed
    // "not a live download" look, so nobody mistakes it for a working App Store link…
    await expect(ios).toHaveAttribute("aria-disabled", "true");
    await expect(ios).toHaveClass(/store-badge-disabled/);

    // …but it is NO LONGER a hard-`disabled` <button>. THIS is the load-bearing before/after line: the
    // reported bug was that the badge was a real `<button disabled>`, and a disabled button emits no
    // click at all — a silent dead no-op. The product fix (app-badges.js) un-disables the DOM `disabled`
    // attribute (while KEEPING aria-disabled, so it's still announced unavailable) so the badge's click
    // listener can answer a tap. This raw hasAttribute check pins that flip precisely: before the fix it
    // was `true` (dead), after it is `false` (answerable).
    expect(await ios.evaluate((el) => el.hasAttribute("disabled"))).toBe(false);
    // It's a real <button> (never a dead link with a phantom href), so there's nothing to navigate to.
    expect(await ios.evaluate((el) => el.tagName)).toBe("BUTTON");

    // Tap it, and assert the honest feedback the fix adds. IMPORTANT: the badge deliberately keeps
    // `aria-disabled="true"` (announced unavailable — it is NOT a live download), and Playwright's
    // actionability treats an `aria-disabled="true"` element as "not enabled", so a plain `.click()`
    // waits for it to become enabled and then TIMES OUT — that was this spec's original CI failure on
    // this exact line ("element is not enabled"). A coordinate `.click({ force: true })` is also
    // unreliable here (the footer badge can sit below the fold / behind boot chrome, so the synthetic
    // mouse events can miss it). So we dispatch the click straight at the element with `dispatchEvent`,
    // which targets the badge's own DOM `click` listener directly — exactly the handler a real user's tap
    // fires — with no hit-testing and no a11y-disabled gate. That listener is what app-badges.js wires
    // (TM-657); it preventDefaults + shows the honest "coming soon" toast asserted below.
    await ios.dispatchEvent("click");

    const toasts = page.locator("#tm-toasts");
    await expect(toasts).toContainText(IOS_TOAST_TEXT);

    // The tap preventDefaults — it stays on the Chat screen, never navigating off to a broken target.
    await expect(page).toHaveURL(/#\/chat$/);
    await expect(page.locator("#chat-view")).toBeVisible();
  });
});
