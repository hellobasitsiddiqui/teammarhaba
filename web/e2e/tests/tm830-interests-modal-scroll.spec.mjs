import { test, expect } from "@playwright/test";
import { EVENT_GOER } from "../fixtures.mjs";

// TM-830 — the profile-edit Interests "+ add" picker MODAL must be reachable on a phone.
//
// The bug: opening the Interests picker from Profile → Interests → "+ add" (an existing user
// adding/editing interests) mounts a `.tm-modal` overlay. With the seeded catalogue (V45 seeds dozens
// of interests across many categories) that modal grows TALLER than the phone viewport, and — because
// its height was capped with `max-height: 100%`, which only constrains when an ancestor has a *definite*
// height and resolved to nothing under the `display:grid; place-items:center` backdrop — the modal grew
// to full content height. That left `.tm-modal-body`'s `overflow-y:auto` inert (a body never needs to
// overflow if its parent isn't height-constrained), so the Save button sat ~1650px below the fold,
// unreachable even after force-scrolling every descendant. See the ticket's live-DOM evidence.
//
// SCOPE: this is the profile-edit MODAL path ONLY. The new-user onboarding interests step is a separate
// FULL-PAGE picker (not a `.tm-modal`) and is deliberately NOT exercised here — an earlier "fix" only
// covered onboarding, which is why the ticket was reopened.
//
// The fix (styles.css .tm-modal): cap the modal to the *viewport* — `max-height: calc(100dvh - insets)`
// (100vh fallback), mirroring the `body` dvh convention (TM-295) and subtracting the backdrop's
// safe-area inset padding — so the flex column is definite-height and the body genuinely scrolls.
//
// This spec runs under the `mobile-chromium` project (Pixel 5 ≈ 393×727 CSS px) — see
// playwright.config.mjs testMatch — so it exercises the real narrow-screen layout the bug lives in.
// Patterns mirror responsive-mobile.spec.mjs (tour suppression, sign-in helper, in-viewport assertion).

// Suppress the first-run product tour: its dimmed overlay would sit over the picker under test. Same
// approach as responsive-mobile.spec.mjs / theme-visual.spec.mjs — make any `tm.tour.*` key read as done.
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

// Sign in as a seeded, onboarded + terms-accepted user (EVENT_GOER, provisioned by global-setup) so the
// session lands straight in the app — no first-run gate to walk. Email+password is behind "Try another
// way" (email-code is the default front door, TM-234).
async function signIn(page) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", EVENT_GOER.email);
  await page.click("#try-another-btn");
  await page.fill("#password", EVENT_GOER.password);
  await page.click("#signin-btn");
  // The viewport-independent "signed in" signal: the signed-OUT login panel disappears (the top-nav
  // sign-out control was removed in TM-906; body[data-auth] from auth-state.mjs is the modern form).
  await expect(page.locator("#auth-signed-out")).toBeHidden();
}

test.describe("@responsive TM-830 profile Interests '+ add' picker modal", () => {
  test("the picker modal fits the phone viewport, its body scrolls, and Save is reachable", async ({
    page,
  }) => {
    await signIn(page);

    // Navigate to the profile HUB (the paper-profile view, not the edit form). Arm the interests-catalogue
    // wait BEFORE the navigation that mounts the profile + fires the catalogue GET, so opening the picker
    // never races an empty catalogue (an unreadable catalogue would render the honest "not available yet"
    // modal — short, and NOT the tall picker the bug is about). paintInterests renders the "+ add" chip
    // once the config + catalogue land.
    const catalogueLoaded = page.waitForResponse(
      (r) => r.url().includes("/api/v1/interests/catalogue") && r.request().method() === "GET",
    );
    await page.evaluate(() => (window.location.hash = "#/profile"));
    await expect(page.locator("#profile-view")).toBeVisible();
    await catalogueLoaded;

    // Open the Interests "+ add" picker. The chip is the "＋ add" button (fullwidth plus) on the
    // Interests card; it's shown while the user is under the max (a freshly-seeded goer has 0 interests).
    const addChip = page.locator(".tm-pf-chip-add", { hasText: "add" });
    await expect(addChip).toBeVisible();
    await addChip.click();

    // The picker mounts as the `.tm-modal` overlay (ui.js modal() → `.tm-dialog.tm-modal`), containing the
    // grouped catalogue and, at the bottom, the Save button (`.tm-pf-picker-actions .tm-btn-primary`).
    const modal = page.locator(".tm-dialog.tm-modal");
    await expect(modal).toBeVisible();
    // Confirm it's the tall CATALOGUE picker (the bug's subject), not the short "not available yet" body.
    await expect(page.locator(".tm-pf-picker-count")).toBeVisible();
    const saveBtn = page.locator(".tm-pf-picker-actions .tm-btn-primary", { hasText: "Save" });
    await expect(saveBtn).toBeVisible();

    // ── Root-cause assertion: the modal must not exceed the visible viewport. ──────────────────────────
    // Pre-fix the modal grew to its full content height (evidence: clientHeight 2548 on a 844px viewport),
    // so it far exceeded the viewport. Post-fix the viewport-relative cap keeps it within it. Allow a
    // small slack for the backdrop inset padding + sub-pixel rounding.
    const geom = await modal.evaluate((el) => {
      const body = el.querySelector(".tm-modal-body");
      return {
        modalHeight: el.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        bodyClientH: body.clientHeight,
        bodyScrollH: body.scrollHeight,
      };
    });
    expect(
      geom.modalHeight,
      `modal (${Math.round(geom.modalHeight)}px) must fit within the ${geom.viewportHeight}px viewport`,
    ).toBeLessThanOrEqual(geom.viewportHeight + 1);

    // ── The body genuinely scrolls: with the tall seeded catalogue the content overflows the (now
    // height-constrained) body, so .tm-modal-body's overflow-y:auto engages (scrollHeight > clientHeight).
    // Pre-fix these were EQUAL (2474 == 2474) — the body never needed to overflow because nothing capped
    // its parent. This is the mechanism the Save-reachability depends on.
    expect(
      geom.bodyScrollH,
      `modal body must be scrollable (scrollHeight ${geom.bodyScrollH} > clientHeight ${geom.bodyClientH})`,
    ).toBeGreaterThan(geom.bodyClientH);

    // ── The user-facing outcome: Save is reachable + clickable. Scroll it into view (a real user scrolls
    // the picker body) and assert it's actually in the viewport and clickable. Pre-fix this FAILS: the
    // button sat ~1650px below the fold and no descendant scroll could bring it in (nothing was
    // scrollable), so scrollIntoViewIfNeeded left it out of the viewport.
    await saveBtn.scrollIntoViewIfNeeded();
    await expect(saveBtn).toBeInViewport();

    // Belt-and-braces: it's genuinely actionable (Playwright's actionability = visible, stable, receives
    // events, enabled). A trial click asserts reachability without mutating state (no PATCH fires). The
    // Save is disabled until the min is met, so pick one interest first to enable it.
    await page.locator(".tm-pf-picker-opt").first().click();
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click({ trial: true });
  });
});
