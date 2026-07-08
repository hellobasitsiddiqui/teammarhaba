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

    // Tap Chat → the refreshed chat LIST (TM-515) + Chat active. The list shows the "Chats" heading and
    // the seed conversations from the paper-chat-list wireframe.
    await page.locator("#tab-chat").click();
    await expect(page.locator("#chat-view")).toBeVisible();
    await expect(page.locator("#chat-view")).toContainText("Chats");
    await expect(page.locator('[data-testid="chat-row"]').first()).toContainText("Sunday Dog Walk");
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

  test("opening a chat row shows the thread, read-receipt ticks and a working composer (TM-515)", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    await page.evaluate(() => (window.location.hash = "#/chat"));
    // Open the first conversation → the thread deep-link, still lighting the Chat tab.
    await page.locator('[data-testid="chat-row"]').first().click();
    await expect(page).toHaveURL(/#\/chat\/sunday-dog-walk$/);
    const thread = page.locator('[data-testid="chat-thread"]');
    await expect(thread).toBeVisible();
    await expect(thread).toContainText("See you all at 10!");
    // The full read-receipt ladder renders (TM-511 component): single, double AND triple tick.
    await expect(thread.locator(".tm-c-ticks--sent")).toHaveCount(1);
    await expect(thread.locator(".tm-c-ticks--read")).toHaveCount(1);
    await expect(thread.locator(".tm-c-ticks--group")).toHaveCount(1);
    await expect(page.locator("#tab-chat")).toHaveAttribute("aria-current", "page");
    // The composer echoes a sent message locally (no backend yet, TM-433).
    await page.locator('[data-testid="chat-composer-input"]').fill("Running 5 late!");
    await page.locator('[data-testid="chat-composer"] .tm-chat-send').click();
    await expect(thread).toContainText("Running 5 late!");
  });

  test("the reaction picker: open an incoming bubble, pick an emoji, and backdrop/Escape close it (TM-536)", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    // Deep-link straight into a populated thread so the react-able incoming bubbles are mounted.
    await page.evaluate(() => (window.location.hash = "#/chat/sunday-dog-walk"));
    const thread = page.locator('[data-testid="chat-thread"]');
    await expect(thread).toBeVisible();

    // Target Mike's incoming message — it has NO seeded reaction, so a pick is a clean FIRST react
    // (a fresh pill appearing, not a count replacing an existing one). Incoming bubbles are buttons
    // (`.tm-chat-bub--react`); outgoing ones are static, so only incoming rows open the picker.
    const mikeRow = thread.locator(".tm-chat-msg--in", { hasText: "bring treats" });
    const mikeBubble = mikeRow.locator(".tm-chat-bub--react");
    await expect(mikeRow.locator(".tm-chat-reaction")).toHaveCount(0);

    // Tap the bubble → the picker opens over its dimmed backdrop and the bubble takes the selection
    // ring. It offers the five reaction emoji plus the "＋ more" affordance (six controls).
    await mikeBubble.click();
    const picker = page.locator(".tm-chat-picker");
    await expect(picker).toBeVisible();
    await expect(mikeBubble).toHaveClass(/tm-chat-bub--selected/);
    await expect(picker.locator(".tm-chat-picker-emoji")).toHaveCount(6);

    // Pick 🎉 → the message gains an inline reaction pill of that emoji (count 1), the picker closes,
    // and the bubble's selection ring clears. (🎉 has no emoji variation selector, so the text
    // assertion is exact.)
    await picker.getByRole("menuitem", { name: "React 🎉" }).click();
    await expect(page.locator(".tm-chat-picker")).toBeHidden();
    await expect(mikeBubble).not.toHaveClass(/tm-chat-bub--selected/);
    const pill = mikeRow.locator(".tm-chat-reaction");
    await expect(pill).toHaveCount(1);
    await expect(pill.locator(".tm-c-reaction__emoji")).toHaveText("🎉");
    await expect(pill).toContainText("1");

    // Reopen → clicking the dimmed backdrop (outside the picker) closes it WITHOUT changing the
    // reaction. Click the top-left corner, well clear of the centred picker card.
    await mikeBubble.click();
    await expect(page.locator(".tm-chat-picker")).toBeVisible();
    await page.locator(".tm-chat-picker-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(page.locator(".tm-chat-picker")).toBeHidden();
    await expect(pill.locator(".tm-c-reaction__emoji")).toHaveText("🎉"); // unchanged

    // Reopen → Escape closes it too (keyboard dismissal).
    await mikeBubble.click();
    await expect(page.locator(".tm-chat-picker")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".tm-chat-picker")).toBeHidden();

    // The overlay never left a stray horizontal scroll behind.
    await expectNoHorizontalPageScroll(page);
  });

  test("the empty conversation shows the first-message prompt (paper-chat-empty, TM-515)", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    await page.evaluate(() => (window.location.hash = "#/chat/park-picnic"));
    await expect(page.locator('[data-testid="chat-empty"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-empty"]')).toContainText("No messages yet");
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
