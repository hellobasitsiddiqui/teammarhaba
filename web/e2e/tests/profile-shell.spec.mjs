import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, dbConfig } from "../fixtures.mjs";

// Profile shell-mount regression (TM-885 / TM-886), at the phone viewport both tickets were
// reported at (390×844 — the tab bar reveals ≤ 33rem/528px).
//
// TM-886 (REPRODUCED on main): the walking-skeleton shell brand block — the "Circle" wordmark h1,
// the "Find your people — complete your circle" tagline and the #status "Ready when you are." line —
// painted ABOVE the Profile screen's own "Profile" header (and above the first-run gates). The boot
// splash and the auth card were correctly dismissed; the leak was this block, whose copy is the same
// brand copy as the auth landing + boot splash (why the report described those). The fix scopes it
// off the self-headed routes via router.js render() → shell-brand-core.js.
//
// TM-885 (NOT reproduced on the routed #/profile): the four-tab bar was present + Profile-active on
// every entry path probed on main. The first test PINS that so it can't regress silently — the
// user's "no bottom buttons on my profile" screen was the tab-bar-less #/onboarding phone re-gate
// (deliberate: a gate must not be side-steppable via a tab), which the third test documents.
test.use({ viewport: { width: 390, height: 844 } });

/** Sign in as the seeded ADMIN (a real, fully-provisioned account — role irrelevant here, the
 *  profile + gates are any-user surfaces) via the email+password "Try another way" path. */
async function signIn(page) {
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  // At the phone width the sign-out control sits behind the hamburger — wait for the signed-in
  // home shell instead (a provisioned account lands straight on #/home).
  await expect(page.locator("#auth-signed-in")).toBeVisible({ timeout: 20_000 });
}

test("@profile-shell #/profile renders inside the app shell: tab bar present, brand/boot chrome absent (TM-885/TM-886)", async ({ page }) => {
  await signIn(page);

  // Enter the profile the everyday way — the bottom Profile tab.
  await expect(page.locator("#tab-profile")).toBeVisible();
  await page.click("#tab-profile");
  await expect(page.locator("#profile-view")).toBeVisible();
  // The screen's own "Profile" <h2> heading exists in the DOM as the accessible name / heading landmark,
  // but is sr-only (visually-hidden) — the visible word is redundant (active Profile tab + identity
  // header below name the screen), so a11y is kept without the redundant visible text. Assert it's
  // present with its accessible name; the AC1 test below asserts its visual box is collapsed.
  await expect(page.locator("h2.tm-pf-title")).toHaveCount(1);
  await expect(page.locator("h2.tm-pf-title")).toContainText("Profile");
  // The identity header (avatar + name) is the first VISIBLE profile block leading the screen.
  await expect(page.locator(".tm-pf-id")).toBeVisible();

  // TM-885 — the bottom navigation is present and Profile-active. This test signs in as the seeded
  // ADMIN, so the bar shows the locked four user tabs plus the injected Admin tab (TM-915) = 5.
  await expect(page.locator("#app-tabbar")).toBeVisible();
  await expect(page.locator("#app-tabbar .app-tab")).toHaveCount(5);
  await expect(page.locator("#tab-profile")).toHaveAttribute("aria-current", "page");

  // TM-886 — the pre-login/boot surfaces are fully gone: the boot splash overlay has been REMOVED
  // from the DOM (boot-screen.js dismiss), and the auth landing card is hidden.
  await expect(page.locator("#boot-screen")).toHaveCount(0);
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // TM-886 — the shell brand block does not paint above the Profile header. These three assertions
  // FAIL on pre-fix main (the block was visible on every non-login route).
  await expect(page.locator("main.app > h1")).toBeHidden();
  await expect(page.locator("main.app > .tagline")).toBeHidden();
  await expect(page.locator("#status")).toBeHidden();
});

test("@profile-shell the identity header is the FIRST visible content — corner-bell out of flow, not a row above it (TM-910 AC1)", async ({ page }) => {
  // TM-910 finding: on #/profile at the phone viewport the account-nav row (bell) stayed in normal
  // flow ABOVE the screen's content, so the content rendered as the SECOND row (AC1 not met). The fix
  // lifts the nav out of flow and pins the bell to the top-right CORNER (position:absolute, top:~1.1rem
  // — physically the highest point), so the content flows to the top and IS the first content, with the
  // bell riding beside/level on its own band (not a full row above it, not overlapping the gear).
  //
  // UPDATE: the visible "Profile" word heading is now redundant (the active Profile tab + the identity
  // header below both name the screen), so .tm-pf-title is sr-only (visually-hidden) — its geometry is
  // degenerate (1×1, offscreen) and no longer expresses "first content". The topmost VISIBLE profile
  // block is now the identity header (.tm-pf-id — avatar + name). So the real invariant is asserted on
  // IT: the identity header starts WITHIN the corner-bell's own band (its top is at or above the bell's
  // BOTTOM edge, within a small delta), i.e. it was NOT pushed a whole ~44px bell-row DOWN as it was on
  // pre-fix main (bell in an in-flow row above → content below the band). Plus the bell stays corner-
  // pinned and never collides with the heading's own top-right gear control.
  await signIn(page);
  await page.click("#tab-profile");
  await expect(page.locator("#profile-view")).toBeVisible();
  // The heading stays in the DOM for screen readers / heading navigation, just visually hidden — assert
  // the accessible heading exists with its name (a11y kept). Its accessible name is still "Profile", so
  // it remains a real <h2> landmark; only its visual box is collapsed (asserted geometrically below —
  // Playwright's toBeVisible() treats a 1×1 clipped sr-only box as "visible", so we check the box size).
  await expect(page.locator(".tm-pf-title")).toHaveCount(1);
  await expect(page.locator(".tm-pf-title")).toContainText("Profile");
  // The identity header (avatar + name) is now the topmost VISIBLE profile block.
  await expect(page.locator(".tm-pf-id")).toBeVisible();
  await expect(page.locator("#nav-notif-bell")).toBeVisible();

  const geo = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    };
    const overlap = (a, b) =>
      Boolean(a) && Boolean(b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const title = rect(".tm-pf-title");
    const identity = rect(".tm-pf-id");
    const bell = rect("#nav-notif-bell");
    const gear = rect(".tm-pf-gear");
    return {
      titleW: title?.w,
      titleH: title?.h,
      identityTop: identity?.top,
      bellTop: bell?.top,
      bellBottom: bell?.bottom,
      bellHeight: bell?.h,
      bellRight: bell?.right,
      viewportWidth: window.innerWidth,
      bellGearOverlap: overlap(bell, gear),
    };
  });

  // The "Profile" heading is sr-only: its rendered box is collapsed to the 1×1 visually-hidden clip
  // (NOT a full text row), so it takes no visual space and the identity header leads. (On pre-fix main
  // the title was a full visible heading row several px tall — this assertion + the box below prove the
  // word is genuinely not rendered.)
  expect(geo.titleW).toBeLessThanOrEqual(2);
  expect(geo.titleH).toBeLessThanOrEqual(2);

  // Content-first (AC1): the identity header — the topmost VISIBLE block now that the "Profile" word is
  // sr-only — starts WITHIN the corner-bell's own band. Its top is above the bell's BOTTOM edge plus a
  // small delta (a bell-height slack absorbs the topbar/gear band the identity sits under), i.e. it was
  // NOT pushed a whole ~44px bell-row DOWN as on pre-fix main (bell in an in-flow row above → content
  // one full bell-row below the band → identityTop > bellBottom + bellHeight). The corner-pinned bell is
  // the highest point, so the content legitimately rides just below it but stays near the app content top.
  expect(geo.identityTop).toBeLessThanOrEqual(geo.bellBottom + geo.bellHeight);
  // The bell is pinned to the top-right corner (right edge within 24px of the viewport right).
  expect(geo.bellRight).toBeGreaterThanOrEqual(geo.viewportWidth - 24);
  // The corner-clustered bell does not collide with the heading's own top-right gear control.
  expect(geo.bellGearOverlap).toBe(false);
});

test("@profile-shell the brand block is restored when leaving the profile (scoping, not deletion)", async ({ page }) => {
  await signIn(page);
  await page.click("#tab-profile");
  await expect(page.locator("#profile-view")).toBeVisible();
  await expect(page.locator("main.app > h1")).toBeHidden();

  // Leaving Profile restores the brand block on a still-branded tab. Home is now self-headed too
  // (TM-908 content-first), so verify the restoration on Events — which keeps the brand block —
  // proving the block was SCOPED off Profile, not deleted.
  await page.click("#tab-events");
  await expect(page.locator("#events-view")).toBeVisible();
  await expect(page.locator("main.app > h1")).toBeVisible();
  await expect(page.locator("main.app > .tagline")).toBeVisible();
});

test("@profile-shell the phone re-gate (#/onboarding) shows its own header only — no brand leak, tab bar deliberately hidden (TM-885 finding)", async ({ page }) => {
  // Simulate a pre-TM-880 "existing account": onboarded, but NO stored phone. The router re-gates
  // it through #/onboarding on every navigation (mandatory phone, #587) — THIS tab-bar-less screen,
  // with the brand block leaking above it, is what the TM-885/TM-886 report described. The phone is
  // nulled directly in the DB because the API layer (correctly) refuses to unset it.
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    await client.query("UPDATE users SET phone = NULL WHERE lower(email) = lower($1)", [ADMIN.email]);

    await signInExpectingGate(page);

    // The gate renders its own header…
    await expect(page.locator("#onboarding-view")).toBeVisible();
    await expect(page.locator("#onboarding-view h2").first()).toContainText("Complete your profile");
    // …the brand block no longer leaks above it (FAILS on pre-fix main)…
    await expect(page.locator("main.app > h1")).toBeHidden();
    await expect(page.locator("main.app > .tagline")).toBeHidden();
    await expect(page.locator("#status")).toBeHidden();
    // …and the tab bar stays hidden ON PURPOSE (a gate must not be side-steppable via a tab —
    // tabbar-core.js shouldShowTabbar). Pinned so "no bottom buttons on the gate" is documented
    // as designed behaviour, not the TM-885 bug.
    await expect(page.locator("#app-tabbar")).toBeHidden();
  } finally {
    // Restore the seeded fixture for the specs that run after this one (global-setup only runs once
    // per suite): put the provisioned phone back.
    await client.query("UPDATE users SET phone = '+447700900123' WHERE lower(email) = lower($1)", [ADMIN.email]);
    await client.end();
  }
});

/** Sign in and wait for the re-gate landing (#/onboarding) instead of home. */
async function signInExpectingGate(page) {
  await page.goto("/#/login");
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  await expect(page.locator("#onboarding-view")).toBeVisible({ timeout: 20_000 });
}
