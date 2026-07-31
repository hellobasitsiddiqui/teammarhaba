import { test, expect } from "@playwright/test";
// iOS "Coming soon" app badge — tap feedback (TM-657).
//
// The reporter originally hit this on an in-app screen: the "Get the app" footer's iOS badge showed
// "Coming soon" but a tap did NOTHING — it was a real `<button disabled>`, and a disabled button emits
// no click, so the tap was a silent dead no-op. app-badges.js (TM-657) un-disables the iOS badge (on
// mobile-web / desktop — NOT inside the native WebView) so it can answer a tap, keeps it announced
// unavailable (aria-disabled="true" + the dimmed .store-badge-disabled look), and on click
// preventDefaults + shows an honest "coming soon" toast instead of silence.
//
// TM-1177 then moved the "Get the app" badges OFF the in-app screens — they now live ONLY on the
// signed-out Sign-in screen and the Help page. So this TM-657 tap→toast check now runs on the signed-out
// login screen (no sign-in needed), where the badge is present. Its RENDER is covered by
// get-the-app-badges.spec.mjs; this spec owns the tap→toast BEHAVIOUR. Rides the main + manual-dispatch
// e2e workflow (never the PR gate), like its siblings.

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

test.describe('@ios-badge iOS "Coming soon" badge answers a tap — on its Sign-in/Help home (TM-657)', () => {
  test('the iOS badge is tappable and toasts "coming soon" instead of doing nothing', async ({
    page,
  }) => {
    // TM-1181 / TM-1177: the "Get the app" badges were REMOVED from the in-app screens (Chat included) —
    // they now live ONLY on the signed-out Sign-in screen and the Help page. So this TM-657 tap→toast
    // check runs on the signed-out login screen, where the iOS "Coming soon" placeholder is present.
    // (get-the-app-badges.spec.mjs already covers its render there; this owns the tap→toast behaviour.)
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();

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
