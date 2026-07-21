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
  await expect(page.locator(".tm-pf-title")).toBeVisible(); // the screen's own "Profile" header

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

test("@profile-shell the 'Profile' heading is the FIRST content — the corner-bell nav is out of flow, not a row above it (TM-910 AC1)", async ({ page }) => {
  // TM-910 finding: on #/profile at the phone viewport the account-nav row (bell) stayed in normal
  // flow ABOVE the "Profile" heading, so the heading rendered as the SECOND row (AC1 not met). The
  // fix lifts the nav out of flow and pins the bell to the top-right corner, so the heading flows to
  // the top and IS the first content, with the bell riding the heading's band (not overlapping the
  // gear). This pins that: the heading's top is at/above the bell's top, and the bell/gear don't
  // overlap. FAILS on pre-fix (heading pushed below the ~44px bell row).
  await signIn(page);
  await page.click("#tab-profile");
  await expect(page.locator("#profile-view")).toBeVisible();
  await expect(page.locator(".tm-pf-title")).toBeVisible();
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
    const bell = rect("#nav-notif-bell");
    const gear = rect(".tm-pf-gear");
    return {
      titleTop: title?.top,
      bellTop: bell?.top,
      bellRight: bell?.right,
      viewportWidth: window.innerWidth,
      bellGearOverlap: overlap(bell, gear),
    };
  });

  // Heading-first: the "Profile" title top is not pushed below the bell (it was a whole row below the
  // ~44px bell band on pre-fix main). Allow a small tolerance for the bell's own top inset.
  expect(geo.titleTop).toBeLessThanOrEqual(geo.bellTop + 4);
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

  // Back to Home: the brand chrome returns (Home's current look keeps it — TM-512 wireframe note).
  await page.click("#tab-home");
  await expect(page.locator("#auth-signed-in")).toBeVisible();
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
