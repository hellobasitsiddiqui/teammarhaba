import { test, expect } from "@playwright/test";
import { ADMIN, TARGET } from "../fixtures.mjs";

// Responsive mobile-web polish (TM-229) — proves the app is usable at a phone viewport. This spec
// runs ONLY under the `mobile-chromium` Playwright project (Pixel 5 ≈ 393px wide; see
// playwright.config.mjs), so every assertion here is about the real narrow-screen layout:
//   • no horizontal PAGE scroll (the classic mobile break),
//   • the account nav collapses behind a hamburger that opens/closes,
//   • the admin users table scrolls inside its wrapper, not the whole page,
//   • primary controls stay usable (visible + in the viewport).
//
// Patterns mirror the existing specs (theme-visual / profile-edit): suppress the first-run tour via
// the localStorage init-script, wait for each view's container before asserting (TM-198 lesson), and
// navigate signed-in views by hash without a full reload to avoid the guard's sign-in bounce.
//
// It rides the existing main + manual-dispatch e2e workflow (never the PR gate), like its siblings.

// A phone viewport never wants a horizontal PAGE scrollbar — a wide child forcing one is the
// canonical responsive bug. We allow a 1px slack for sub-pixel rounding. (A scroll container INSIDE
// the page — e.g. the admin table wrapper — is fine and expected; this checks the document itself.)
async function expectNoHorizontalPageScroll(page) {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return { scrollW: el.scrollWidth, clientW: el.clientWidth };
  });
  expect(overflow.scrollW, "document should not scroll horizontally").toBeLessThanOrEqual(
    overflow.clientW + 1,
  );
}

async function expectControlUsable(page, locator) {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
}

async function signInAsAdmin(page) {
  // Email-code is the default front door (TM-234); the email+password form lives under "Try another
  // way" — reveal it first, same as the other specs' helper.
  await page.fill("#email", ADMIN.email);
  await page.click("#try-another-btn");
  await page.fill("#password", ADMIN.password);
  await page.click("#signin-btn");
  // Wait for auth to ACTUALLY resolve before the caller navigates. #signout-btn lives in the
  // collapsed nav at a phone viewport, so toBeVisible() never holds; the viewport-independent
  // "signed in" signal is the signed-OUT login panel disappearing. (Asserting too early would let
  // the caller's hash navigation race the guard back to #/login.)
  await expect(page.locator("#auth-signed-out")).toBeHidden();

  // ...BUT signed-in alone isn't enough to navigate to a protected view yet (TM-325). The router
  // (router.js) navigates off #/login IMMEDIATELY on auth change using fail-safe cached values
  // (non-admin, NOT gated), then resolves role + the first-run gates (onboarding TM-250, terms
  // TM-170) from GET /api/v1/me in the BACKGROUND and re-guards. Until that resolves, an immediate
  // `location.hash = "#/admin"` races AHEAD of the gate resolution: the late /me flips needsTerms/
  // isOnboarded and the re-guard bounces the session to #/onboarding or #/terms, stranding the
  // admin view hidden for the whole timeout. The desktop admin-walkthrough spec dodges this by
  // waiting for #nav-admin to be VISIBLE before navigating — but at a phone viewport #nav-admin
  // lives inside the collapsed hamburger nav, so toBeVisible() never holds.
  //
  // The viewport-independent equivalent of that desktop signal is the #nav-admin link's `hidden`
  // ATTRIBUTE (set by render() in router.js, not the CSS collapse): the router removes it only once
  // the session is signed-in AND the ADMIN role has resolved AND NEITHER first-run gate is up
  // (`!(signedIn && isAdmin) || gated`). So waiting for that attribute to clear proves /me has
  // resolved and the session is un-gated + role-resolved — exactly the "app-ready" point a real
  // (slower) phone user reaches before they can open the admin console. Covers BOTH gates at once.
  await expect(page.locator("#nav-admin")).not.toHaveAttribute("hidden", /.*/);
}

// Suppress the first-run product tour (its dimmed overlay would cover the controls under test).
// Same approach as theme-visual.spec.mjs: make any `tm.tour.*` key read as completed at boot.
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

test.describe("@responsive login at a phone viewport", () => {
  test("no horizontal page scroll and the primary login control is usable", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    // The default front door is the email-code button (TM-234); email+password is behind "Try
    // another way". Assert the primary control a phone user actually sees.
    await expectControlUsable(page, page.locator("#emailcode-send-btn"));
    await expectNoHorizontalPageScroll(page);
  });

  test("the hamburger toggle is shown at a phone viewport", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    // The toggle is hidden by the `hidden` attribute only when router/JS hides it; at this width the
    // CSS reveals it (display:inline-grid). It must be visible AND a real ≥44px tap target.
    const toggle = page.locator("#nav-toggle");
    await expect(toggle).toBeVisible();
    const box = await toggle.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("@responsive the account nav collapses behind a hamburger", () => {
  test("opens to reveal the utility menu and closes after navigating", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    // Land on home so the signed-in nav items exist.
    await page.evaluate(() => (window.location.hash = "#/home"));
    await expect(page.locator("#auth-signed-in")).toBeVisible();

    const nav = page.locator(".app-nav");
    const toggle = page.locator("#nav-toggle");
    // Post-TM-434 the hamburger is the UTILITY menu on mobile — the primary destinations moved to the
    // bottom tab bar. The Help page link is a utility item that stays in it, so assert against that.
    const helpLink = page.locator("#nav-help-link");

    // Collapsed by default: the menu group is not displayed, so the Help link isn't visible.
    await expect(helpLink).toBeHidden();
    await expect(nav).toHaveAttribute("data-nav-open", "false");

    // Open the menu → utility items become visible + aria-expanded reflects state.
    await toggle.click();
    await expect(nav).toHaveAttribute("data-nav-open", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectControlUsable(page, helpLink);

    // Exactly one primary nav on mobile (TM-434): the primary Events/Profile destinations now live in
    // the bottom tab bar and are NOT duplicated inside the hamburger, so they stay hidden even when the
    // menu is open.
    await expect(page.locator(".app-nav-items > #nav-profile")).toBeHidden();
    await expect(page.locator(".app-nav-items > #nav-events")).toBeHidden();

    // Clicking a utility item navigates AND closes the menu (TM-229 nav-toggle.js behaviour).
    await helpLink.click();
    await expect(nav).toHaveAttribute("data-nav-open", "false");
    await expect(page.locator("#help-view")).toBeVisible();
  });
});

test.describe("@responsive bottom tab bar (TM-434)", () => {
  test("shows the four locked-order tabs, reflects the active route, and navigates each", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    await page.evaluate(() => (window.location.hash = "#/home"));
    await expect(page.locator("#auth-signed-in")).toBeVisible();

    const tabbar = page.locator("#app-tabbar");
    await expect(tabbar).toBeVisible();

    // Four tabs in the LOCKED order: Home · Events · Chat · Profile.
    await expect(tabbar.locator(".app-tab")).toHaveCount(4);
    await expect(tabbar.locator(".app-tab-label")).toHaveText(["Home", "Events", "Chat", "Profile"]);

    // Each tab is a real ≥44px tap target.
    for (const id of ["#tab-home", "#tab-events", "#tab-chat", "#tab-profile"]) {
      const box = await page.locator(id).boundingBox();
      expect(box.height, `${id} tap target`).toBeGreaterThanOrEqual(44);
    }

    // On #/home the Home tab is the selected one (clear active-tab state).
    await expect(page.locator("#tab-home")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#tab-profile")).not.toHaveAttribute("aria-current", /.*/);

    // Tap Profile → the profile view + Profile becomes the active tab.
    await page.locator("#tab-profile").click();
    await expect(page.locator("#profile-view")).toBeVisible();
    await expect(page.locator("#tab-profile")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#tab-home")).not.toHaveAttribute("aria-current", /.*/);

    // Tap Events → the events view + Events active.
    await page.locator("#tab-events").click();
    await expect(page.locator("#events-view")).toBeVisible();
    await expect(page.locator("#tab-events")).toHaveAttribute("aria-current", "page");

    // Tap Chat → the API-backed chat LIST (TM-438) + Chat active. The list shows the "Chats" heading and
    // the unified conversation-list container (event chats + admin broadcasts, read from GET
    // /api/v1/me/conversations — rows depend on backend seeding, so we assert the container not a row).
    await page.locator("#tab-chat").click();
    await expect(page.locator("#chat-view")).toBeVisible();
    await expect(page.locator("#chat-view")).toContainText("Chats");
    await expect(page.locator('[data-testid="chat-list"]')).toBeVisible();
    await expect(page.locator("#tab-chat")).toHaveAttribute("aria-current", "page");

    // Tap Home → back to the home view + Home active.
    await page.locator("#tab-home").click();
    await expect(page.locator("#auth-signed-in")).toBeVisible();
    await expect(page.locator("#tab-home")).toHaveAttribute("aria-current", "page");

    // The fixed bar never forces the page to scroll sideways.
    await expectNoHorizontalPageScroll(page);
  });

  test("a #/chat deep link lands with the Chat tab active", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    await page.evaluate(() => (window.location.hash = "#/chat"));
    await expect(page.locator("#chat-view")).toBeVisible();
    await expect(page.locator('[data-testid="chat-list"]')).toBeVisible();
    await expect(page.locator("#tab-chat")).toHaveAttribute("aria-current", "page");
  });

  test("opening a chat thread shows the read-only thread view: back-to-list chrome, no composer (TM-438)", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    // Deep-link into a thread route. Whatever the backend returns for this id (messages, an empty
    // thread, or not-a-member), the shell always renders its thread chrome: a back-to-list control and
    // the Chat tab lit. Message posting is a later ticket (TM-447), so there is NO composer here.
    await page.evaluate(() => (window.location.hash = "#/chat/1"));
    await expect(page.locator("#chat-view")).toBeVisible();
    await expect(page.locator(".tm-chat-back")).toBeVisible();
    await expect(page.locator("#tab-chat")).toHaveAttribute("aria-current", "page");
    await expect(page.locator('[data-testid="chat-composer"]')).toHaveCount(0);

    // Back returns to the unified conversation list.
    await page.locator(".tm-chat-back").click();
    await expect(page.locator('[data-testid="chat-list"]')).toBeVisible();
    await expect(page.locator("#chat-view")).toContainText("Chats");
    await expectNoHorizontalPageScroll(page);
  });

  test("the notifications feed renders and Mark all read clears the unread rows (TM-515)", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    await page.evaluate(() => (window.location.hash = "#/notifications"));
    await expect(page.locator("#notifications-view")).toBeVisible();
    const feed = page.locator('[data-testid="notifications"]');
    await expect(feed).toContainText("Sunday Morning Dog Walk");
    await expect(feed).toContainText("A spot opened up — claim it before it's gone");
    // Three unread rows to start; Mark all read clears them.
    await expect(page.locator('[data-testid="notification"][data-read="false"]')).toHaveCount(3);
    await page.locator('[data-testid="notifs-mark-all"]').click();
    await expect(page.locator('[data-testid="notification"][data-read="false"]')).toHaveCount(0);
  });

  test("the tab bar is hidden on the signed-out auth gate", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    // Signed out → the router keeps the bar's `hidden` attribute set (no app sections to tab between).
    await expect(page.locator("#app-tabbar")).toBeHidden();
  });
});

test.describe("@responsive admin users console at a phone viewport", () => {
  test("table renders, scrolls inside its wrapper, and the page does not scroll sideways", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);

    await page.evaluate(() => (window.location.hash = "#/admin"));
    await expect(page.locator("#admin-view")).toBeVisible();
    await expect(page.locator("#admin-table")).toBeVisible();

    // The seeded target row is present (the view actually populated, not an empty shell).
    const targetRow = page.locator("#admin-table tr", { hasText: TARGET.email });
    await expect(targetRow).toBeVisible();

    // The wide table is allowed to scroll WITHIN its wrapper; the wrapper is the overflow container.
    const canScrollInside = await page.evaluate(() => {
      const w = document.getElementById("admin-table");
      return w ? w.scrollWidth >= w.clientWidth : false;
    });
    expect(canScrollInside).toBeTruthy();

    // But that wide table must NOT force the whole page to scroll horizontally.
    await expectNoHorizontalPageScroll(page);

    // The row's primary action is still usable on a phone.
    await expectControlUsable(page, targetRow.getByRole("button").first());
  });
});

test.describe("@responsive edit-profile at a phone viewport", () => {
  test("the form fits and Save changes is usable", async ({ page }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);

    // Arm the /me wait BEFORE the navigation that mounts the form (TM-198 lesson).
    const meLoaded = page.waitForResponse(
      (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
    );
    await page.evaluate(() => (window.location.hash = "#/profile"));
    await expect(page.locator("#profile-form")).toBeVisible();
    await meLoaded;

    await expectControlUsable(page, page.getByRole("button", { name: "Save changes" }));
    await expectNoHorizontalPageScroll(page);
  });
});
