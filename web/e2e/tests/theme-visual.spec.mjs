import { test, expect } from "@playwright/test";
import { expectSignedIn } from "../helpers/auth-state.mjs";
import { ADMIN, TARGET } from "../fixtures.mjs";

// Paper appearance guard (TM-216 origin; rewritten for the single Paper theme in TM-529). The
// multi-theme family system (clean/doodle/sketch + the ?theme= override) is retired — Paper is the
// only theme, and the two things a user personalises are surfaced in profile settings:
//   • the accent swatch (a fixed curated palette), and
//   • the wavy/sketchy toggle (`<html data-sketchy="on|off">`).
// This spec proves (a) every key page renders under Paper with its primary control usable (a cheap
// "no layout break" invariant, no pixel snapshots), and (b) the two per-user controls apply LIVE and
// PERSIST SERVER-SIDE — a reload re-reads the choice from GET /api/v1/me, not localStorage. It rides
// the existing E2E workflow (main + manual dispatch), never the PR gate.
//
// Waits mirror the existing specs (TM-198 lesson — always wait for the async load to settle before
// asserting): we wait for each view's container, and for signed-in pages we wait for the
// router's body[data-auth] signed-in signal (auth-state.mjs, TM-906).

/** Read <html data-sketchy> (the wavy/sketchy state applied by appearance.js / appearance-sync.js). */
async function sketchyState(page) {
  return page.evaluate(() => document.documentElement.getAttribute("data-sketchy"));
}

/** Read the inline --accent custom property (set by the swatch picker / appearance-sync). */
async function inlineAccent(page) {
  return page.evaluate(() => document.documentElement.style.getPropertyValue("--accent").trim());
}

// Cheap "no layout break" invariant for a primary control: it must be visible, on-screen and
// interactable — catches a look that hides/collapses/shoves a control without exact-pixel flake.
async function expectControlUsable(page, locator) {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
}

async function signInAsAdmin(page) {
  // Email-code is the default front door (TM-234); the email+password form is under "Try another way".
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expectSignedIn(page);
}

// Suppress the first-run product tour (TM-147): its modal + backdrop would overlay the pages under
// test. Make any `tm.tour.*` key read as completed at boot so no tour auto-runs (works for any uid).
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

test.describe("@theme the app renders the single Paper theme", () => {
  test("boots to Paper with the sketchy toggle on by default and no theme-family switch", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    // Default (signed-out / brand-new) = sketchy ON (the app's character, TM-529).
    await expect.poll(() => sketchyState(page)).toBe("on");
    // The retired multi-theme axis is gone — <html> carries no data-theme.
    const hasThemeAttr = await page.evaluate(() => document.documentElement.hasAttribute("data-theme"));
    expect(hasThemeAttr).toBe(false);
  });
});

// The login page is reachable anonymously — exercise it directly under Paper.
test.describe("@theme login page renders under Paper", () => {
  test("login is usable", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    // Primary control: the email-code "Email me a code" submit, the default front door (TM-234).
    await expectControlUsable(page, page.locator("#emailcode-send-btn"));
  });
});

// The authenticated pages (home, profile, admin) under Paper. One sign-in, then walk the views by
// hash (no reload) — closer to real usage and avoids the guard's sign-in bounce on a deep-link load.
test.describe("@theme authenticated pages render under Paper", () => {
  test("home, profile and admin are usable", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);

    // HOME.
    await page.evaluate(() => (window.location.hash = "#/home"));
    await expect(page.locator("#auth-signed-in")).toBeVisible();
    await expectControlUsable(page, page.locator("#nav-profile"));

    // PROFILE — wait for the async GET /me populate before asserting (TM-198).
    const meLoaded = page.waitForResponse(
      (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
    );
    await page.evaluate(() => (window.location.hash = "#/profile"));
    await expect(page.locator("#profile-form")).toBeVisible();
    await meLoaded;
    await expectControlUsable(page, page.getByRole("button", { name: "Save changes" }));

    // ADMIN — navigate by hash; assert the table populated with the target user's row.
    await page.evaluate(() => (window.location.hash = "#/admin/users"));
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-table")).toBeVisible();
    const targetRow = page.locator("#admin-table tr", { hasText: TARGET.email });
    await expect(targetRow).toBeVisible();
    await expectControlUsable(page, targetRow.getByRole("button").first());
  });
});

// The two per-user Paper controls in profile settings — the heart of TM-529. Proves each applies LIVE
// and PERSISTS SERVER-SIDE: after changing them we RELOAD, and appearance-sync re-reads the choice
// from GET /api/v1/me (not localStorage) and re-applies it. This is the server round-trip, end to end.
//
// Determinism (TM-516). Two racy patterns were driving the flake; both are removed here:
//   1. The wavy/sketchy control's <input> is the ACCESSIBLE checkbox behind the styled pill: 1px,
//      opacity 0, position:absolute (see .tm-switch-input in styles.css). Driving it with
//      locator.check()/uncheck() is flaky — Playwright has to scroll a click-point for that 1px node
//      into the viewport near the bottom of a long, still-settling profile page, and intermittently
//      reports "element is outside of the viewport" until the 60s timeout. We click the VISIBLE label
//      instead (the control a real user hits): a normally-sized element that scrolls in reliably and
//      toggles the same checkbox. The 2rem swatch buttons are already normal-sized, so they stay clicks.
//   2. We never wait on GET /api/v1/me. appearance-sync fires that GET on auth-resolve/session-restore
//      (not on a navigation or reload we control), so arming waitForResponse for it just races the
//      already-fired fetch and hangs. Instead we gate on the CONTROL's own reflected state
//      (toBeChecked / the applied <html> attrs via expect.poll) — the real "controls are populated"
//      signal. The PATCH waits stay: those fire on the click we control, so arming them first is correct.
test.describe("@theme the accent swatch + wavy/sketchy toggle persist per user", () => {
  test("changing the accent + toggle applies live and survives a reload", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);

    // Open profile. The appearance controls build synchronously from the applied <html> state (set by
    // appearance-sync from GET /me on auth-resolve, during signInAsAdmin) — no GET re-fires on this nav.
    await page.evaluate(() => (window.location.hash = "#/profile"));
    await expect(page.locator("#profile-form")).toBeVisible();

    const appearance = page.locator("#appearance-settings");
    await expectControlUsable(page, appearance);

    // The hidden a11y checkbox (read state off it) + the visible label we actually click (see note 1).
    const sketchy = page.locator("#appearance-sketchy");
    const sketchyLabel = appearance.locator("label.tm-switch");

    // Readiness + deterministic baseline: the shared admin account's stored default is sketchy ON and
    // the control reflects it. Waiting on this (auto-retried) IS the "controls are populated from /me"
    // signal — the load-bearing thing the deleted GET wait used to (racily) stand in for.
    await expect(sketchy).toBeChecked();

    // Turn the wavy/sketchy toggle OFF (→ clean Paper). Arm the PATCH wait before the click.
    let patched = page.waitForResponse((r) => r.url().includes("/api/v1/me") && r.request().method() === "PATCH");
    await sketchyLabel.click();
    await patched;
    await expect(sketchy).not.toBeChecked();
    await expect.poll(() => sketchyState(page)).toBe("off"); // applied live, no reload

    // Pick the coral accent swatch (→ re-tints --accent live + persists).
    patched = page.waitForResponse((r) => r.url().includes("/api/v1/me") && r.request().method() === "PATCH");
    await appearance.locator('.tm-swatch[data-accent="coral"]').click();
    await patched;
    await expect.poll(() => inlineAccent(page)).toBe("#d1495b");

    // RELOAD with no ?theme= trick — the persisted choice must be re-read from the server and applied.
    await page.goto("/#/login");
    // Warm session restores; appearance-sync fires GET /me on auth-resolve and applies the stored look.
    // Gate on the APPLIED state (retried), NOT a GET wait that can fire before it's armed.
    await expect.poll(() => sketchyState(page), { timeout: 15_000 }).toBe("off");
    await expect.poll(() => inlineAccent(page), { timeout: 15_000 }).toBe("#d1495b");

    // Restore the defaults so the shared emulator account doesn't leak state into other specs/retries.
    await page.evaluate(() => (window.location.hash = "#/profile"));
    await expect(appearance).toBeVisible();
    await expect(sketchy).not.toBeChecked(); // reflects the persisted "off" applied above
    patched = page.waitForResponse((r) => r.url().includes("/api/v1/me") && r.request().method() === "PATCH");
    await sketchyLabel.click(); // → back ON
    await patched;
    await expect(sketchy).toBeChecked();
    patched = page.waitForResponse((r) => r.url().includes("/api/v1/me") && r.request().method() === "PATCH");
    await appearance.locator('.tm-swatch[data-accent="teal"]').click(); // → back to teal
    await patched;
  });
});
