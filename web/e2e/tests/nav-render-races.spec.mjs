import { test, expect } from "@playwright/test";
import { ADMIN, TARGET } from "../fixtures.mjs";

// Nav/render races + deep links (TM-733) — a browser walkthrough for one of the three MEDIUM findings
// batched from the TM-655 review: the ADMIN deep-link / reload bounce race.
//
// The bug (router.js:541-546 with 857-869): the router navigates FIRST on an auth change and resolves
// the role in the BACKGROUND (the TM-307 navigate-first design). The admin-route guard used `!isAdmin`
// directly, but `isAdmin` fails safe to `false` until that background lookup resolves — so a real admin
// who DEEP-LINKED or RELOADED straight to `#/admin/users` was ALWAYS bounced to Home with a spurious
// "Admins only." error toast, and (worse) never returned even once the role resolved. The fix gates the
// bounce on a new `roleResolved` flag (shouldBounceNonAdmin: bounce only once the role is KNOWN and it
// is not admin), so a reload/deep-link to an admin route is HELD until the role settles, then the
// console mounts for the confirmed admin.
//
// Why a RELOAD is the faithful trigger: an in-app hash nav (`location.hash = "#/admin/users"`) reuses the
// already-resolved session where `isAdmin`/`roleResolved` are true — that never hit the bug. The bug
// lives on the COLD path where the router re-resolves the role from scratch: Firebase restores the
// persisted session (browserLocalPersistence, as avatar-upload.spec relies on) and `resolveRoleThenGuard`
// runs afresh with `roleResolved=false` + `isAdmin=false` while the role lookup is in flight — exactly a
// reload onto `#/admin/users`. Pre-fix that reload bounced to `#/home` + toasted "Admins only."; post-fix the
// admin users console (#admin-view / #admin-table) mounts, the hash stays `#/admin/users`, and NO error toast
// appears.
//
// This is deterministic (not a race the test must "win"): the fix makes the outcome correct regardless
// of how slowly the role lookup resolves — the route is held, never bounced, for a real admin.
//
// Patterns mirror the sibling specs (responsive-mobile / admin-walkthrough): the per-spec email+password
// sign-in helper (email-code is the default front door since TM-234; email+password lives under "Try
// another way"), the tour-suppression beforeEach, the seeded ADMIN/TARGET accounts, real DOM-id
// selectors, and @tag naming. It rides the existing main + manual-dispatch e2e workflow (never the PR
// gate), like its siblings. Runs under the default desktop `chromium` project (its filename isn't in the
// mobile testMatch), so #nav-admin toBeVisible() is a valid "role resolved" signal (as admin-walkthrough
// uses it).

/**
 * Sign in as the seeded ADMIN via the real Firebase Auth emulator flow, and wait until the ADMIN role
 * has actually RESOLVED (not merely "signed in"). The desktop "role resolved" signal is #nav-admin
 * becoming visible: the router removes its `hidden` attribute only once the session is signed-in AND
 * the ADMIN role has resolved from GET /api/v1/me (admin-walkthrough.spec relies on the same signal).
 * Waiting for it proves the FIRST, warm session is fully role-resolved before we then force the COLD
 * reload path the bug lives on.
 */
async function signInAsAdmin(page) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  // Email-code is the default front door (TM-234); the email+password form lives under "Try another way".
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  // Signed in AND ADMIN role resolved (admin nav only un-hides for ROLE_ADMIN once /me has resolved).
  await expect(page.locator("#signout-btn")).toBeVisible();
  await expect(page.locator("#nav-admin")).toBeVisible();
}

// Suppress the first-run product tour (its dimmed overlay would cover the controls under test). Same
// approach as the sibling specs (theme-visual / responsive-mobile): make any `tm.tour.*` key read as
// completed at boot.
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

test.describe("@nav-races admin deep-link / reload bounce race (TM-733)", () => {
  test("reloading straight onto #/admin/users holds the route and mounts the console for a real admin — no 'Admins only.' bounce", async ({
    page,
  }) => {
    // 1. Sign in as ADMIN and let the FIRST (warm) session fully resolve the role.
    await signInAsAdmin(page);

    // 2. Warm hash nav to the console works (this path never hit the bug — the role is already
    //    resolved here). Establishes the console DOES mount for this admin, so the reload assertion
    //    below is about the COLD path specifically, not a broken account.
    await page.evaluate(() => (window.location.hash = "#/admin/users"));
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-table")).toBeVisible();
    // The seeded target row is present — the console actually populated, not an empty shell.
    await expect(page.locator("#admin-table tr", { hasText: TARGET.email })).toBeVisible();

    // 3. THE CRUX — reload while the hash is #/admin/users. Firebase restores the persisted session and the
    //    router re-resolves the role FROM SCRATCH (roleResolved=false, isAdmin=false while the /me
    //    lookup is in flight) straight onto an admin route. This is exactly the deep-link/reload path
    //    the guard used to bounce.
    await page.reload();

    // 4. Post-fix behaviour: the route is HELD until the role resolves, then the console mounts for the
    //    confirmed admin. The admin view + table render again after the reload...
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-table")).toBeVisible();
    await expect(page.locator("#admin-table tr", { hasText: TARGET.email })).toBeVisible();

    // ...and the URL stayed on #/admin/users (pre-fix the guard did `go(HOME)`, landing the reload on
    //    #/home). Asserts the guard did NOT bounce.
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/admin/users");
    await expect(page.locator("#admin-view")).toBeVisible();

    // ...and NO spurious "Admins only." error toast was raised. That toast is the exact papercut the fix
    //    removed: pre-fix the reload bounced the admin to Home AND toasted this. Poll a beat so a
    //    late-firing toast (if the bug regressed) would be caught, then assert it never appears.
    await expect(page.locator("#nav-admin")).toBeVisible(); // role has re-resolved post-reload
    await expect(
      page.locator("#tm-toasts .tm-toast-error", { hasText: "Admins only." }),
    ).toHaveCount(0);
  });
});
