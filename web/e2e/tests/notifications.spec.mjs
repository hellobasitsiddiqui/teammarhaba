// Notifications — header bell + panel P0 journeys (TM-738).
//
// The always-on header bell (notification-bell.js, TM-455) + the bell-opened panel
// (notification-panel.js, TM-456) are the primary in-app notification surface for a signed-in,
// onboarded user, on every screen. This spec proves the three P0 journeys against a LIVE backend +
// Postgres + the Firebase Auth emulator (no route mocks for the live paths), plus one crafted-input
// SECURITY journey that IS mocked (its whole point is a payload the real backend would never emit):
//
//   E2E-02  header bell shows an unread badge from a seeded admin/system notification → clicking the
//           bell marks everything SEEN (POST /me/notifications/seen), which clears the badge → the
//           opened panel LISTS the caller's notifications (including our stamped one).
//   E2E-03  tapping a panel item DEEP-LINKS to a safe in-app route + POSTs mark-read
//           (POST /me/notifications/{id}/read), so the item flips read and the caller's UNREAD count
//           decrements.
//   E2E-04  SECURITY — a crafted/off-app deepLink (javascript: / http: / scheme-relative //host) is
//           INERT: the panel's safeRoute trust boundary (notification-panel-core.js) strips it, so
//           tapping the row NEVER navigates the WebView off-origin.
//
// HOW WE SEED (live, E2E-02/03). There is no user-facing "create a notification" flow, so — exactly
// like events.spec.mjs seeds events via the admin API — we write a REAL durable feed notification
// through the real admin path POST /api/v1/admin/messages (TM-441, AdminMessageService →
// NotificationWriter): an ADMIN sends a title/body (+ optional deep-link) to a resolved audience, which
// delivers one ADMIN_MESSAGE inbox row per active recipient (push-pref-independent). We target the
// browser user by RSVPing them GOING to a throwaway event and sending to that event's attendees
// (eventIds audience), so the notification lands in THEIR feed with a real server id we can later
// assert mark-read against — no need for the caller's numeric DB id (GET /me exposes only the uid).
//
// DEEP-LINK CHOICE (E2E-03). The admin-message deep-link is validated server-side against the STRICTER
// exact allow-list PushRoutes.isKnown (#/home, #/profile, #/admin, #/help, #/onboarding, #/login,
// #/membership) — NOT the events/chat DETAIL patterns. So the parameterised #/events/{id} the ticket
// names as an example is intentionally NOT admin-message-emittable; we seed a KNOWN safe route
// (#/profile) instead. The panel's safeRoute accepts #/profile identically, so the tap→navigate→
// mark-read journey is proven end to end all the same. (#/events/{id} safe-routing is separately unit-
// tested in the pure core; here the live seam only speaks isKnown routes.)
//
// The bell lives in the header nav (index.html #nav-notif-bell), visible at every width, so this runs
// under the DEFAULT desktop `chromium` project (it is NOT in the playwright.config testMatch that opts
// specs into the phone `mobile-chromium` project) — no bottom-tab-bar / phone-only surface is used.
//
// `screenshot: "on"` is set globally (playwright.config.mjs); we ALSO take explicit named shots at each
// major step so the run yields a step-by-step visual trail to attach to the sprint evidence ticket.

import { test, expect } from "@playwright/test";
import { ADMIN, EVENT_GOER, API_BASE_URL } from "../fixtures.mjs";
import { authHeadersFor, createEvent, apiRsvp, resetAttendanceFor } from "../events-api.mjs";

// Suppress the first-run product tour (TM-147) so its dimmed backdrop can't cover the header bell /
// panel under test — the identical localStorage init-script every other spec uses (seeded accounts
// look "first-run" each run since the emulator wipes their localStorage).
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

/** Sign in a seeded, un-gated account via the email+password ("Try another way") flow — the same path
 *  events.spec.mjs / broadcast-admin.spec.mjs / tm710-announcement.spec.mjs use. The account is
 *  provisioned onboarded + terms-accepted in global-setup, so it lands straight in the app. */
async function signIn(page, account) {
  await page.goto("/#/login");
  await expect(page.locator("#auth-signed-out")).toBeVisible();
  await page.fill("#email", account.email);
  await page.click("#try-another-btn");
  await page.fill("#password", account.password);
  await page.click("#signin-btn");
  await expect(page.locator("#auth-signed-out")).toBeHidden();
  await expect(page.locator("#auth-signed-in")).toBeVisible();
}

/** A named step-screenshot helper (on top of the global screenshot:"on") — a step-by-step trail. */
function stepShot(page, testInfo, prefix) {
  let n = 0;
  return (name) =>
    page.screenshot({
      path: testInfo.outputPath(`${prefix}-${String(++n).padStart(2, "0")}-${name}.png`),
      fullPage: true,
    });
}

/**
 * Seed a REAL admin/system notification into `recipient`'s live feed via the admin path (mirrors how
 * events.spec.mjs seeds events). Creates a throwaway event, RSVPs the recipient GOING (so they're a
 * resolvable member of the event audience), then — as the ADMIN — sends an admin message to that
 * event's attendees (POST /api/v1/admin/messages, eventIds audience). The stamped title/body make the
 * later UI/feed assertions match only THIS run's notification, never a lookalike from another spec
 * sharing the CI database. `deepLink` must be a PushRoutes.isKnown route (validated server-side).
 * Returns the stamped { event, title, body, deepLink } so the test can assert on exactly its own row.
 */
async function seedAdminNotification(recipient, { title, body, deepLink }) {
  const adminHeaders = await authHeadersFor(ADMIN);

  // Reset the recipient's attendance first so a lingering GOING from an earlier run can't trip the
  // one-active-event guard (TM-413) on this RSVP — same guard-clearing the events specs do.
  const recipientHeaders = await resetAttendanceFor(recipient);

  // A throwaway event whose only job is to make `recipient` a resolvable member of an eventIds
  // audience; capacity is ample so the RSVP always lands GOING (not WAITLISTED).
  const event = await createEvent(adminHeaders, { heading: title, capacity: 20 });
  const rsvp = await apiRsvp(recipientHeaders, event.id);
  expect(rsvp.state).toBe("GOING");

  // Send the admin message to the event's GOING attendees — delivers one ADMIN_MESSAGE inbox row to
  // `recipient` (push-pref-independent), so it surfaces on their bell + panel.
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/messages`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ title, body, deepLink, eventIds: [event.id] }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`seed admin message failed: ${res.status} ${await res.text()}`);
  }
  return { event, title, body, deepLink };
}

/** The recipient's live bell counts (GET /api/v1/me/notifications/badge → { unseen, unread }). */
async function fetchBadge(recipient) {
  const headers = await authHeadersFor(recipient);
  const res = await fetch(`${API_BASE_URL}/api/v1/me/notifications/badge`, { headers });
  if (!res.ok) throw new Error(`fetch badge failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── E2E-02 ─────────────────────────────────────────────────────────────────────────────
// The bell paints an unread badge from a seeded notification; opening the bell marks-seen (clearing
// the badge) and the panel lists the caller's notifications.
test("@notifications @notif-bell the bell badges a seeded notification, opening marks-seen + lists it", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "notif-bell");
  const stamp = Date.now();
  const title = `TeamMarhaba update ${stamp}`;
  const body = `An automated notification for the header-bell e2e (${stamp}).`;

  // ── SETUP: seed a real notification into EVENT_GOER's feed via the admin path. #/profile is a
  // PushRoutes.isKnown route so the admin-message send accepts it (validated server-side). ─────────
  await seedAdminNotification(EVENT_GOER, { title, body, deepLink: "#/profile" });

  // ── STEP 1: sign in — the bell is now visible in the header (signed-in + un-gated). ──────────────
  await signIn(page, EVENT_GOER);
  const bell = page.locator("#nav-notif-bell");
  await expect(bell).toBeVisible();

  // ── STEP 2: the unread badge chip paints — it's shown (not hidden-at-zero) with a non-empty count,
  // and the bell's aria-label announces the exact unread total ("Notifications, N unread"). The chip
  // itself is aria-hidden (the count rides the label), so we assert its text + visibility, not a role.
  const badge = bell.locator(".tm-notif-badge");
  await expect(badge).toBeVisible();
  await expect(badge).not.toHaveText("");
  await expect(bell).toHaveAttribute("aria-label", /Notifications, \d+ unread/);
  await shot("bell-badged");

  // ── STEP 3: click the bell → it marks EVERYTHING seen (POST /me/notifications/seen) then opens the
  // panel. Arm the response capture BEFORE the click so we assert the mark-seen call actually fired
  // (that's what clears the badge, TM-455). ────────────────────────────────────────────────
  const seenResponse = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/notifications/seen") && r.request().method() === "POST",
  );
  await bell.click();
  const seen = await seenResponse;
  expect(seen.status()).toBe(200);
  // The mark-seen response is the now-zeroed counts — unseen is 0 (the badge source), so the badge
  // clears from the response with no follow-up GET (TM-455/TM-556).
  const seenBody = await seen.json();
  expect(seenBody.unseen).toBe(0);

  // ── STEP 4: the badge chip is now cleared (hidden at zero-unseen). ────────────────────────────
  await expect(badge).toBeHidden();

  // ── STEP 5: the panel opened and LISTS the caller's notifications, including our stamped row. It's
  // an ungrouped ADMIN_MESSAGE item ([data-testid="notif-panel-item"]) carrying the seeded title/body.
  await expect(page.locator("#tm-notif-panel")).toBeVisible();
  await expect(page.locator('[data-testid="notif-panel-list"]')).toBeVisible();
  const item = page.locator('[data-testid="notif-panel-item"]', { hasText: title });
  await expect(item).toBeVisible();
  await expect(item).toContainText(body);
  await shot("panel-listed");
});

// ── E2E-03 ─────────────────────────────────────────────────────────────────────────────
// Tapping a panel item deep-links to a safe in-app route + marks it read, decrementing the unread
// count.
test("@notifications @notif-panel tapping an item deep-links safely + marks it read (unread decrements)", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "notif-panel");
  const stamp = Date.now();
  const title = `Open your profile ${stamp}`;
  const body = `Tap to review your profile (${stamp}).`;
  const route = "#/profile"; // a PushRoutes.isKnown safe route (the events/chat DETAIL routes aren't
  //                            admin-message-emittable — see the file header); safeRoute accepts it.

  // ── SETUP: seed a real, deep-linked notification into EVENT_GOER's feed via the admin path. ──────
  await seedAdminNotification(EVENT_GOER, { title, body, deepLink: route });

  // The recipient's UNREAD count before the tap — the read flag is per-item and SURVIVES mark-seen, so
  // opening the bell (below) won't touch it; only the item tap will. We assert this decrements.
  const before = await fetchBadge(EVENT_GOER);
  expect(before.unread).toBeGreaterThanOrEqual(1);

  // ── STEP 1: sign in and open the bell to reveal the panel (which also marks all SEEN — irrelevant
  // to the unread count we're asserting). Our stamped item is present and rendered UNREAD. ──────────
  await signIn(page, EVENT_GOER);
  await page.locator("#nav-notif-bell").click();
  await expect(page.locator("#tm-notif-panel")).toBeVisible();
  const item = page.locator('[data-testid="notif-panel-item"]', { hasText: title });
  await expect(item).toBeVisible();
  // It starts unread: the row carries the unread styling hook + data-read="false" (TM-456).
  await expect(item).toHaveClass(/tm-np-row--unread/);
  await expect(item).toHaveAttribute("data-read", "false");
  await shot("panel-item-unread");

  // ── STEP 2: tap it → the panel fires POST /me/notifications/{id}/read (mark-read), closes, and
  // deep-links to the safe route. Arm the read-response capture BEFORE the tap so we prove mark-read
  // actually fired (TM-456), and confirm it targeted a real /read endpoint (not a crafted URL). ─────
  const readResponse = page.waitForResponse(
    (r) => /\/api\/v1\/me\/notifications\/\d+\/read$/.test(r.url()) && r.request().method() === "POST",
  );
  await item.click();
  const read = await readResponse;
  expect(read.status()).toBe(200);

  // ── STEP 3: it deep-linked to the SAFE in-app route — the hash is #/profile and the profile view is
  // shown. Navigation stayed same-origin (a hash route), never off-app. ────────────────────────────
  await expect(page).toHaveURL(new RegExp(`#/profile$`));
  await expect(page.locator("#profile-view")).toBeVisible();
  // The panel closed on tap (TM-456 onTapItem → close()).
  await expect(page.locator("#tm-notif-panel")).toHaveCount(0);
  await shot("deep-linked-profile");

  // ── STEP 4: the UNREAD count decremented — the tapped item is now read server-side. Assert via the
  // live badge API (server-authoritative), and via the UI: re-opening the bell shows the same row now
  // rendered READ (data-read="true", no unread class). ───────────────────────────────────────
  await expect
    .poll(async () => (await fetchBadge(EVENT_GOER)).unread, { timeout: 10_000 })
    .toBe(before.unread - 1);

  await page.locator("#nav-notif-bell").click();
  await expect(page.locator("#tm-notif-panel")).toBeVisible();
  const reopened = page.locator('[data-testid="notif-panel-item"]', { hasText: title });
  await expect(reopened).toHaveAttribute("data-read", "true");
  await expect(reopened).not.toHaveClass(/tm-np-row--unread/);
  await shot("item-now-read");
});

// ── E2E-04 (SECURITY) ────────────────────────────────────────────────────────────────────
// A crafted/off-app deepLink is INERT: the panel's safeRoute trust boundary strips it, so tapping the
// row can never navigate the WebView off-origin. This is the ONE journey we drive through a network
// mock: a real backend can never emit these payloads (the admin allow-list rejects them at send), so
// to exercise the CLIENT-SIDE trust boundary we feed the crafted feed straight to GET /me/notifications
// at the network seam and prove the DOM refuses to act on it. No live seeding, no backend rows.
test("@notifications @notif-security a crafted off-app deepLink is inert — the WebView never leaves origin", async ({
  page,
}, testInfo) => {
  const shot = stepShot(page, testInfo, "notif-security");

  // The crafted feed: each item carries an off-app deepLink the safeRoute contract MUST reject —
  //   • javascript:  → a script-URL injection (the classic XSS/nav-hijack payload),
  //   • http://evil  → an absolute external URL (escapes the app off-origin),
  //   • //evil.test  → a scheme-relative URL (also resolves off-origin).
  // safeRoute strips every one to null, so buildPanel gives each row NO route → onTapItem marks it
  // read (interaction = seen) but navigates NOWHERE. We prove no navigation off-origin happens.
  const craftedFeed = {
    items: [
      {
        id: 9000001,
        type: "ADMIN_MESSAGE",
        title: "Crafted javascript: link",
        body: "This must never run as a script URL.",
        deepLink: "javascript:window.__pwned=1",
        sourceRef: null,
        sticky: false,
        createdAt: "2026-07-15T10:00:03Z",
        seenAt: null,
        readAt: null,
        seen: false,
        read: false,
      },
      {
        id: 9000002,
        type: "ADMIN_MESSAGE",
        title: "Crafted absolute http: link",
        body: "This must never navigate off-origin.",
        deepLink: "http://evil.example.com/steal",
        sourceRef: null,
        sticky: false,
        createdAt: "2026-07-15T10:00:02Z",
        seenAt: null,
        readAt: null,
        seen: false,
        read: false,
      },
      {
        id: 9000003,
        type: "ADMIN_MESSAGE",
        title: "Crafted scheme-relative link",
        body: "This must never navigate off-origin.",
        deepLink: "//evil.example.com/steal",
        sourceRef: null,
        sticky: false,
        createdAt: "2026-07-15T10:00:01Z",
        seenAt: null,
        readAt: null,
        seen: false,
        read: false,
      },
    ],
    page: 0,
    size: 20,
    totalElements: 3,
    totalPages: 1,
  };

  // Mock ONLY the feed read — everything else (auth, /me, mark-seen, mark-read) hits the real backend,
  // so the app is otherwise fully live. The mark-read POST for these crafted ids would 404 on the real
  // backend, but onTapItem's mark-read is fire-and-forget (swallowed) — the security claim is about the
  // NAVIGATION, not the read call — so a 404 there doesn't affect the assertion.
  await page.route("**/api/v1/me/notifications**", (routeReq) => {
    const url = routeReq.request().url();
    // Only stub the feed LIST (GET …/me/notifications[?…]); let /badge, /seen and /{id}/read pass to
    // the real backend so the bell still opens the panel normally.
    if (/\/me\/notifications(\?|$)/.test(url) && routeReq.request().method() === "GET") {
      return routeReq.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(craftedFeed),
      });
    }
    return routeReq.fallback();
  });

  // Sign in (real) as EVENT_GOER, then open the bell → the panel loads the CRAFTED feed via the mock.
  await signIn(page, EVENT_GOER);
  const origin = new URL(page.url()).origin;
  const flagBefore = await page.evaluate(() => window.__pwned ?? null);
  expect(flagBefore).toBeNull();

  await page.locator("#nav-notif-bell").click();
  await expect(page.locator("#tm-notif-panel")).toBeVisible();
  // All three crafted rows render as normal item rows (the panel never trusts the link to build them).
  const rows = page.locator('[data-testid="notif-panel-item"]');
  await expect(rows).toHaveCount(3);
  await shot("crafted-panel");

  // Tap each crafted row in turn. Because safeRoute stripped its deepLink to null, onTapItem navigates
  // NOWHERE — the hash stays an in-app route, the origin never changes, and no javascript: URL runs.
  // (The panel closes on each tap; re-open it for the next row.)
  const craftedTitles = [
    "Crafted javascript: link",
    "Crafted absolute http: link",
    "Crafted scheme-relative link",
  ];
  for (const title of craftedTitles) {
    if (!(await page.locator("#tm-notif-panel").count())) {
      await page.locator("#nav-notif-bell").click();
      await expect(page.locator("#tm-notif-panel")).toBeVisible();
    }
    await page.locator('[data-testid="notif-panel-item"]', { hasText: title }).click();

    // The load-bearing security assertion: we're still on the SAME ORIGIN, on an in-app hash route —
    // the crafted target was never navigated to.
    const current = new URL(page.url());
    expect(current.origin).toBe(origin);
    expect(current.hash).toMatch(/^#\//); // a normal in-app hash route (e.g. #/home / #/login), never off-app
    expect(current.href).not.toContain("evil.example.com");
    expect(current.protocol).not.toBe("javascript:");
    // The javascript: payload never executed — its side-effect global is still unset.
    expect(await page.evaluate(() => window.__pwned ?? null)).toBeNull();
  }
  await shot("still-on-origin");
});
