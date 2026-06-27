import { test, expect } from "@playwright/test";
import { ADMIN, TARGET } from "../fixtures.mjs";

// Theme-switch guard (TM-216; extended for sketch in TM-236). Proves a theme can't silently break a
// page: the app boots in the CONFIGURED theme, and every key page renders under EVERY registered
// family (`clean`, `doodle`, `sketch`) with its primary control still visible and un-covered (no
// layout break). New families join by being added to the THEMES constant below. This is the test side of the
// Grows-Skin epic — it asserts the *mechanism* (data-theme is right) and a cheap *visual* invariant
// (the primary control isn't clipped to nothing or hidden under an overlay), without pinning exact
// pixels. It rides the existing E2E workflow (main + manual dispatch), never the PR gate.
//
// How it flips themes WITHOUT a redeploy: the TM-216 dev override in theme.js. serve.mjs injects an
// e2e config with NO `theme` key, so config resolves to the default ("sketch" since TM-323). Adding
// `?theme=clean` (or `?theme=doodle`) to the URL query forces that theme at boot, layered over
// config. Because the app hash-routes (`/#/...`), the query must sit BEFORE the hash: `/?theme=clean#/login`.
//
// Waits mirror the existing specs (TM-198 lesson — always wait for the async load to settle before
// asserting): we wait for each view's container to be visible, and for signed-in pages we wait for
// `#signout-btn` (auth has resolved) before checking nav-driven controls.

const THEMES = ["clean", "doodle", "sketch"];

/** Build a hash route carrying the `?theme=` dev override in the query (before the hash). */
function routeWithTheme(theme, hashRoute) {
  return `/?theme=${theme}#${hashRoute}`;
}

/** Assert <html data-theme> is the one we asked for (the override actually took effect at boot). */
async function expectTheme(page, theme) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(theme);
}

// Cheap "no layout break" invariant for a primary control: it must be visible and, after scrolling
// it into view if needed, sit inside the viewport with a real (non-zero) box. This catches a theme
// that hides a control, collapses it, or pushes/shoves it off-screen, without the flakiness of
// exact-pixel snapshots.
async function expectControlUsable(page, locator) {
  // "Usable" = visible, on-screen, and interactable. Use Playwright's built-ins, NOT a manual
  // elementFromPoint hit-test — that false-fails on controls below the fold or with inner content
  // at their centre (TM-216). scrollIntoViewIfNeeded + toBeInViewport is a reliable no-layout-break
  // signal; if a theme regression hid or shoved a control off-screen, this catches it.
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
  await expect(page.locator("#signout-btn")).toBeVisible();
}

// Suppress the first-run product tour (TM-147): its modal + dimmed backdrop would overlay the pages
// under test (covering controls, blocking nav). The tour persists `{done:true}` in localStorage
// keyed by uid+tourId; make any `tm.tour.*` key read as completed at boot so no tour auto-runs
// (works for any uid). General hygiene — the tour will flake any spec that lingers long enough.
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

test.describe("the app boots in the configured theme", () => {
  test("with no override, config resolves to the default sketch theme", async ({ page }) => {
    // serve.mjs injects a config WITHOUT `theme`, so resolveTheme() falls back to DEFAULT_THEME.
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await expectTheme(page, "sketch");

    // The contract helpers are published for reuse, and the default is sketch (TM-323).
    const contract = await page.evaluate(() => ({
      def: window.TeamMarhabaTheme?.DEFAULT_THEME,
      allowed: window.TeamMarhabaTheme?.ALLOWED,
    }));
    expect(contract.def).toBe("sketch");
    expect(contract.allowed).toEqual(["clean", "doodle", "sketch"]);
  });

  test("an unknown override value is ignored (falls back to the configured theme)", async ({ page }) => {
    // `?theme=neon` isn't ALLOWED → ignored → config's default (sketch) wins. A bad value never
    // breaks or blanks the page.
    await page.goto("/?theme=neon#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await expectTheme(page, "sketch");
  });
});

// The login page is reachable anonymously — exercise it directly under both themes.
test.describe("login page renders under both themes", () => {
  for (const theme of THEMES) {
    test(`login is usable under ${theme}`, async ({ page }) => {
      await page.goto(routeWithTheme(theme, "/login"));
      await expect(page.locator("#auth-signed-out")).toBeVisible();
      await expectTheme(page, theme);
      // Primary control: the email-code "Email me a code" submit, the default front door (TM-234).
      await expectControlUsable(page, page.locator("#emailcode-send-btn"));
    });
  }
});

// The authenticated pages (home, profile, admin) under both themes. One sign-in per theme, then
// walk the three views. Sign in as ADMIN so the admin nav/view is available too.
//
// We load the override ONCE via the initial `?theme=` query, then move between views WITHOUT a full
// page reload — by clicking nav links or setting the hash. This is both closer to real usage and
// avoids the guard's brief sign-in bounce that a fresh deep-link load of a protected route incurs
// (a full reload restores the Firebase session async, so the guard can flash #/login first). The
// `?theme=` value lives in location.search, which survives hash navigation, and theme.js sets
// data-theme once at boot — so the theme stays applied across the whole walk.
test.describe("authenticated pages render under both themes", () => {
  for (const theme of THEMES) {
    test(`home, profile and admin are usable under ${theme}`, async ({ page }) => {
      // Sign in on the login route already carrying the override. As an ADMIN the guard lands us on
      // the admin console (TM-141); we then navigate explicitly to each view below.
      await page.goto(routeWithTheme(theme, "/login"));
      await expect(page.locator("#auth-signed-out")).toBeVisible();
      await expectTheme(page, theme);
      await signInAsAdmin(page);

      // HOME (#/home, #auth-signed-in). Navigate via the hash (no reload) and assert the home card
      // plus a primary control (the Profile nav link, shown for any signed-in user).
      await page.evaluate(() => (window.location.hash = "#/home"));
      await expect(page.locator("#auth-signed-in")).toBeVisible();
      await expectTheme(page, theme);
      await expectControlUsable(page, page.locator("#nav-profile"));

      // PROFILE (#/profile) — reached by clicking the nav link, the real path a user takes. Wait for
      // the async GET /me populate to settle before asserting (the form mounts empty and fills from
      // that response — TM-198). Arm the wait BEFORE the click that triggers the mount GET.
      const meLoaded = page.waitForResponse(
        (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
      );
      await page.evaluate(() => (window.location.hash = "#/profile"));
      await expect(page.locator("#profile-form")).toBeVisible();
      await meLoaded;
      await expectTheme(page, theme);
      // Primary control: the Save changes submit button.
      await expectControlUsable(page, page.getByRole("button", { name: "Save changes" }));

      // ADMIN (#/admin) — navigate by hash (robust; avoids nav-link click-actionability flake). The
      // console builds its table into #admin-view; assert the table renders and the target user's
      // row is present (the view actually populated, not just an empty shell).
      await page.evaluate(() => (window.location.hash = "#/admin"));
      await expect(page.locator("#admin-view")).toBeVisible();
      await expect(page.locator("#admin-table")).toBeVisible();
      const targetRow = page.locator("#admin-table tr", { hasText: TARGET.email });
      await expect(targetRow).toBeVisible();
      await expectTheme(page, theme);
      // Primary control: the row's first action button — by role, NOT the "Disable" text. An earlier
      // spec (admin-walkthrough) may have already disabled this user (shared emulator state), which
      // flips the button to "Enable"; we only assert the row's primary action is usable.
      await expectControlUsable(page, targetRow.getByRole("button").first());
    });
  }
});
