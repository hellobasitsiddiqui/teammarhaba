import { test, expect } from "@playwright/test";
import { ADMIN, TARGET, API_BASE_URL } from "../fixtures.mjs";
import { authHeadersFor, createEvent, apiRsvp, resetAttendanceFor } from "../events-api.mjs";

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
  // Wait for auth to ACTUALLY resolve before the caller navigates. The viewport-independent
  // "signed in" signal is the signed-OUT login panel disappearing (equivalently: body[data-auth]
  // flipping — auth-state.mjs / TM-906; the top-nav sign-out control no longer exists). Asserting
  // too early would let the caller's hash navigation race the guard back to #/login.
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

/**
 * Seed a REAL admin/system notification into `recipient`'s live feed via the admin path — the same
 * technique notifications.spec.mjs uses (there is no user-facing "create a notification" flow, so we
 * write a durable feed row through the real admin seam, exactly like events.spec.mjs seeds events).
 * Creates a throwaway event, RSVPs the recipient GOING (so they're a resolvable member of the event
 * audience), then — as the ADMIN — sends an admin message to that event's attendees
 * (POST /api/v1/admin/messages, eventIds audience), delivering one ADMIN_MESSAGE inbox row to the
 * recipient. The stamped title/body make the later feed assertion match only THIS run's notification,
 * never a lookalike from another spec sharing the CI database. Returns the stamped { title, body }.
 *
 * This replaces the pre-TM-745 assertion of the removed FAKE feed strings ("Sunday Morning Dog Walk",
 * "A spot opened up …"): the #/notifications screen now renders the caller's REAL feed (GET
 * /me/notifications → notifications-core.js mapFeed), so we seed a real row and assert THAT.
 */
async function seedAdminNotification(recipient, { title, body }) {
  const adminHeaders = await authHeadersFor(ADMIN);
  // Clear any lingering GOING from an earlier run so the one-active-event guard (TM-413) can't reject
  // this RSVP — same guard-clearing the events specs do.
  const recipientHeaders = await resetAttendanceFor(recipient);
  // A throwaway event whose only job is to make `recipient` a resolvable member of an eventIds
  // audience; ample capacity so the RSVP always lands GOING (never WAITLISTED).
  const event = await createEvent(adminHeaders, { heading: title, capacity: 20 });
  const rsvp = await apiRsvp(recipientHeaders, event.id);
  expect(rsvp.state).toBe("GOING");
  // Send the admin message to the event's GOING attendees — one ADMIN_MESSAGE inbox row for the
  // recipient (push-pref-independent), so it surfaces on their notifications feed.
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/messages`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ title, body, eventIds: [event.id] }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`seed admin message failed: ${res.status} ${await res.text()}`);
  }
  return { title, body };
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
    // Land on a signed-in route that STILL carries the floating hamburger so the utility-menu
    // open/close behaviour under test is reachable. NOTE (TM-908): Home (#/home) is now content-first
    // — corner-bell.js hides #nav-toggle and pins the bell top-right there — so the hamburger no
    // longer exists on Home. #/notifications is a signed-in utility screen that keeps the normal nav
    // row, so the hamburger + its collapsed menu are present to exercise here.
    await page.evaluate(() => (window.location.hash = "#/notifications"));
    await expect(page.locator("#notifications-view")).toBeVisible();

    const nav = page.locator(".app-nav");
    const toggle = page.locator("#nav-toggle");
    // Post-TM-434 the hamburger is the UTILITY menu on mobile — the primary destinations moved to the
    // bottom tab bar. TM-1024 removed the Help link from the nav (the desktop nav is now exactly the four
    // tabs), so this test now asserts against the Admin link — a utility entry that stays in the hamburger
    // for the admin we signed in as (Admin is NOT one of the four primary tabs, so it isn't hidden by the
    // tm-has-tabbar rule the primary links get).
    const adminLink = page.locator("#nav-admin");

    // Collapsed by default: the menu group is not displayed, so the Admin link isn't visible.
    await expect(adminLink).toBeHidden();
    await expect(nav).toHaveAttribute("data-nav-open", "false");

    // Open the menu → utility items become visible + aria-expanded reflects state.
    await toggle.click();
    await expect(nav).toHaveAttribute("data-nav-open", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectControlUsable(page, adminLink);

    // Exactly one primary nav on mobile (TM-434 / TM-1024): the four primary tab destinations
    // (Home · Events · Chat · Profile) now live in the bottom tab bar and are NOT duplicated inside the
    // hamburger, so they stay hidden even when the menu is open.
    await expect(page.locator(".app-nav-items > #nav-home")).toBeHidden();
    await expect(page.locator(".app-nav-items > #nav-events")).toBeHidden();
    await expect(page.locator(".app-nav-items > #nav-chat")).toBeHidden();
    await expect(page.locator(".app-nav-items > #nav-profile")).toBeHidden();

    // Clicking a utility item navigates AND closes the menu (TM-229 nav-toggle.js behaviour).
    await adminLink.click();
    await expect(nav).toHaveAttribute("data-nav-open", "false");
    // The Admin link opens the #/admin hub (TM-917), which mounts into #admin-hub-view.
    await expect(page.locator("#admin-hub-view")).toBeVisible();
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

    // The LOCKED four (Home · Events · Chat · Profile) plus the injected Admin tab (TM-915) — this
    // suite signs in as the seeded ADMIN, so the bar carries the admin-only fifth tab last.
    await expect(tabbar.locator(".app-tab")).toHaveCount(5);
    await expect(tabbar.locator(".app-tab-label")).toHaveText(["Home", "Events", "Chat", "Profile", "Admin"]);

    // Each tab is a real ≥44px tap target (incl. the injected Admin tab).
    for (const id of ["#tab-home", "#tab-events", "#tab-chat", "#tab-profile", "#tab-admin"]) {
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

  test("opening a chat thread shows the member thread view: back-to-list chrome + a message composer (TM-448)", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    // Deep-link into a member thread. The shell renders its thread chrome — a back-to-list control and
    // the Chat tab lit — AND, since TM-448 shipped in-thread posting (with TM-464 live SSE layered on
    // top), a working message composer: an input + a send button. On a COLD deep-link the conversation
    // type isn't in the list cache, so composeAvailability() defaults the box to ENABLED (chat-core.js /
    // chat.js buildComposer). The disabled/read-only composer is kept only where a thread is genuinely
    // one-way — an ADMIN_BROADCAST announcement — which composeAvailability's unit tests cover
    // (web/tools/chat-core.test.mjs). This migrates the stale TM-438 "no composer" assertion (the thread
    // view was read-only before TM-448) to the current composer-bearing thread.
    await page.evaluate(() => (window.location.hash = "#/chat/1"));
    await expect(page.locator("#chat-view")).toBeVisible();
    await expect(page.locator(".tm-chat-back")).toBeVisible();
    await expect(page.locator("#tab-chat")).toHaveAttribute("aria-current", "page");
    // The composer is present and usable (TM-448): the input + the send button both render.
    await expect(page.locator('[data-testid="chat-composer"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-send"]')).toBeVisible();

    // Back returns to the unified conversation list.
    await page.locator(".tm-chat-back").click();
    await expect(page.locator('[data-testid="chat-list"]')).toBeVisible();
    await expect(page.locator("#chat-view")).toContainText("Chats");
    await expectNoHorizontalPageScroll(page);
  });

  test("the notifications feed renders a seeded row and Mark all read clears the unread rows (TM-515, TM-745)", async ({
    page,
  }) => {
    // TM-745 replaced the hardcoded fake feed (buildFeed) with the REAL feed (mapFeed from GET
    // /me/notifications), so the old fabricated strings ("Sunday Morning Dog Walk", "A spot opened
    // up …") no longer render — this asserts the real feed instead. Seed a durable admin/system
    // notification into the ADMIN's own feed via the admin path (mirrors notifications.spec.mjs),
    // then assert the app paints THAT seeded row and Mark all read clears the unread state.
    const stamp = Date.now();
    const title = `Responsive feed check ${stamp}`;
    const body = `A seeded notification for the mobile notifications-feed e2e (${stamp}).`;
    await seedAdminNotification(ADMIN, { title, body });

    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);
    await page.evaluate(() => (window.location.hash = "#/notifications"));
    await expect(page.locator("#notifications-view")).toBeVisible();

    // The real feed renders the seeded row (mapFeed maps the notification's title into the note text).
    const feed = page.locator('[data-testid="notifications"]');
    await expect(feed).toBeVisible();
    const seededRow = page.locator('[data-testid="notification"]', { hasText: title });
    await expect(seededRow).toBeVisible();
    // It starts unread (server read flag is false for a freshly-seeded row).
    await expect(seededRow).toHaveAttribute("data-read", "false");

    // At least our seeded row is unread; Mark all read clears every unread row (client-side transform).
    await expect
      .poll(async () => page.locator('[data-testid="notification"][data-read="false"]').count())
      .toBeGreaterThanOrEqual(1);
    await page.locator('[data-testid="notifs-mark-all"]').click();
    await expect(page.locator('[data-testid="notification"][data-read="false"]')).toHaveCount(0);
    // The seeded row is still present, now rendered read.
    await expect(seededRow).toHaveAttribute("data-read", "true");
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

    await page.evaluate(() => (window.location.hash = "#/admin/users"));
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

  test("text inputs stay within their card at a very narrow (≈320px) viewport (TM-665)", async ({
    page,
  }) => {
    await page.goto("/#/login");
    await expect(page.locator("#auth-signed-out")).toBeVisible();
    await signInAsAdmin(page);

    const meLoaded = page.waitForResponse(
      (r) => r.url().includes("/api/v1/me") && r.request().method() === "GET",
    );
    await page.evaluate(() => (window.location.hash = "#/profile"));
    await expect(page.locator("#profile-form")).toBeVisible();
    await meLoaded;

    // Reproduce the SMALLEST real phone width — the Samsung Z Flip cover screen is ≈321px. The bug only
    // manifests below ~340px, so the sibling 393px (Pixel 5) test above never caught it: a .tm-form-field
    // grid item with the default min-width:auto refused to shrink and broke the First/Last name inputs
    // out past their card's right edge.
    await page.setViewportSize({ width: 320, height: 900 });

    // Assert EVERY form control is CONTAINED within the edit-profile card — text inputs, the notification
    // and country <select>s (.tm-input), AND the native avatar file input (.tm-avatar-file, which has no
    // .tm-input class). Containment is deliberately stronger than a page-scroll-only check: it pins each
    // control, not just the aggregate. (Verified to fail on main pre-fix — the text fields broke out to
    // ~346 vs card ~299; the avatar file input floored the page at ~378px on its own.)
    const brokeOut = await page.evaluate(() => {
      const card = document.querySelector(".tm-pf-edit");
      const cardRight = card.getBoundingClientRect().right;
      const bad = [];
      for (const control of card.querySelectorAll(".tm-input, .tm-avatar-file")) {
        const right = control.getBoundingClientRect().right;
        if (right > cardRight + 1) {
          bad.push({ id: control.id, right: Math.round(right), cardRight: Math.round(cardRight) });
        }
      }
      return bad;
    });
    expect(brokeOut, `controls breaking out of the edit-profile card: ${JSON.stringify(brokeOut)}`).toEqual(
      [],
    );

    // The zoom-out guard: on a phone under ~378px, a control that can't shrink (the native file input was
    // the culprit — TM-665) floors documentElement.scrollWidth WIDER than the viewport, so Android WebView
    // opens Profile ZOOMED OUT with a right-hand gap. html has overflow-x:hidden (NOT clip), so the root
    // stays measurable and scrollWidth still reveals it — assert the page is no wider than the screen.
    const pageWidth = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    expect(
      pageWidth.scrollW,
      `page (${pageWidth.scrollW}px) must not exceed the ${pageWidth.clientW}px viewport — a wider page opens zoomed-out`,
    ).toBeLessThanOrEqual(pageWidth.clientW + 1);

    // Centring guard (TM-665): the edit-profile card must sit with roughly EQUAL left/right margins.
    // Regression: .profile-view was min(48rem, 96vw) — wider than main.app's padded content box on a
    // narrow phone, which broke `margin: auto` and pinned the cards ~14px off-centre (left gap 14 vs
    // right gap 0). Assert symmetry within a small tolerance.
    const gaps = await page.evaluate(() => {
      const r = document.querySelector(".tm-pf-edit").getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(window.innerWidth - r.right) };
    });
    expect(
      Math.abs(gaps.left - gaps.right),
      `edit-profile card off-centre: leftGap=${gaps.left} rightGap=${gaps.right}`,
    ).toBeLessThanOrEqual(2);

    await expectNoHorizontalPageScroll(page);
  });
});
