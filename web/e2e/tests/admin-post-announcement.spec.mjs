// Event-chat OPENING MESSAGE — auto-post-once idempotency, LIVE UI evidence (TM-710).
//
// Sibling coverage split: tm710-announcement.spec.mjs proves the ADMIN-SENT announcement path (an
// admin POSTs to a thread via POST /conversations/{id}/announcements). This spec covers the OTHER
// TM-710 AC — the OPTIONAL PRECONFIGURED EVENT OPENING MESSAGE that auto-posts ONCE as an announcement
// when the event's chat first opens, and is IDEMPOTENT (never re-posted on re-open / a second RSVP /
// redeploy — guarded by the event's opening_message_posted_at stamp).
//
// The fix under test (EventChatLifecycleService.postOpeningMessageIfPending, called from onGoing):
//   • an event created WITH an openingMessage auto-posts that text as an ANNOUNCEMENT (kind
//     ANNOUNCEMENT, null sender) the first time the chat opens — i.e. the first GOING RSVP;
//   • it is stamped opening_message_posted_at in the same transaction, so a SECOND GOING landing (the
//     chat re-opening for another attendee) does NOT post it again.
// Before the fix there was no opening-message field, no auto-post, and no idempotency stamp — so BOTH
// the "renders as the distinct announcement card" assertion and the "appears exactly once after a
// second RSVP" assertion would fail; after the fix both pass.
//
// Setup is fully API-driven through the SAME first-party paths production uses, mirroring the sibling
// (tm710-announcement.spec.mjs) and tm709-late-join-history.spec.mjs — NO new seed endpoint:
//   1. ADMIN creates an event WITH an openingMessage (POST /api/v1/admin/events — createEvent override).
//   2. EVENT_GOER RSVPs GOING → the event's group thread opens for the first time
//      (EventChatLifecycleService.onGoing) → the opening message auto-posts once as an ANNOUNCEMENT.
//   3. EVENT_WAITER ALSO RSVPs GOING to the SAME event → onGoing fires again (the chat "re-opens" for a
//      second attendee) → the idempotency guard must NOT re-post the opening message.
//   4. The read API is queried (GET /conversations/{id}/messages) to assert the opening-message body
//      appears in EXACTLY ONE announcement-kind message — the load-bearing idempotency assertion.
//   5. The browser signs in as the member, opens Chat → the thread, and asserts the opening message
//      renders as the DISTINCT centred announcement card ([data-testid="chat-announcement"], the
//      "📣 Announcement" attribution + the body) — NOT an ordinary attendee bubble — with a named
//      screenshot trail for the ticket evidence.
//
// This spec's filename is NOT in the mobile-chromium testMatch, so it runs under the DESKTOP chromium
// project only (see playwright.config.mjs). The bottom tab bar (#tab-chat, TM-434) is display:none at
// desktop width, so the Chat surface is reached via the viewport-independent #/chat hash route instead
// (the same path chat-ios-button.spec.mjs / chat-live-stream.spec.mjs use under the desktop project) —
// NOT the mobile-only tab bar the sibling tm710-announcement.spec.mjs uses in the mobile project.

import { test, expect } from "@playwright/test";
import { ADMIN, EVENT_GOER, EVENT_WAITER, API_BASE_URL } from "../fixtures.mjs";
import { authHeadersFor, createEvent, apiRsvp, resetAttendanceFor } from "../events-api.mjs";

// Suppress the first-run product tour (TM-147) so its dimmed backdrop can't cover the chat surface —
// the identical localStorage init-script every other spec uses (seeded accounts look "first-run" each
// run since the emulator wipes their localStorage).
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
 *  events.spec.mjs / chat-foundation.spec.mjs / tm710-announcement.spec.mjs use. The account is
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

/** Find the id of the caller's EVENT_GROUP conversation for `eventId` via the real read API
 *  (GET /me/conversations — TM-436). The summary rows carry `eventId`, so this is a keyed match,
 *  never a title guess. Throws loudly if the thread hasn't been opened (a setup bug to surface). */
async function findConversationId(headers, eventId) {
  const res = await fetch(`${API_BASE_URL}/api/v1/me/conversations?size=100`, { headers });
  if (!res.ok) {
    throw new Error(`list conversations failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const row = (body.items || []).find((c) => c.eventId === eventId);
  if (!row) {
    throw new Error(`no EVENT_GROUP conversation found for event ${eventId} — did the GOING RSVP open it?`);
  }
  return row.id;
}

/** Read a thread's messages via the real members-only read API (GET /conversations/{id}/messages —
 *  chronological, paged), as the account behind `headers`. Returns the ConversationMessageResponse
 *  items (each carrying `kind` + `body` — TM-710). A big page size so a single call sees the whole
 *  (tiny) thread. Throws loudly on a non-2xx so a setup/permission slip surfaces, not a silent [].*/
async function readMessages(headers, conversationId) {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/conversations/${conversationId}/messages?size=200`,
    { headers },
  );
  if (!res.ok) {
    throw new Error(`read messages failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return body.items || [];
}

test.describe("@chat-announcement event opening message auto-posts once, idempotently (TM-710)", () => {
  test("a configured opening message auto-posts as ONE announcement card and is not re-posted on a second RSVP", async ({
    page,
  }, testInfo) => {
    const shot = stepShot(page, testInfo, "tm710-opening-message");
    const stamp = Date.now();
    const heading = `e2e TM-710 opening message ${stamp}`;
    // A distinctive, stamped opening-message body so every assertion — API count + the UI card — can
    // only match THIS event's opening message, never a lookalike from another run against the shared
    // CI database.
    const openingText = `Welcome to the group! Say hi and introduce yourself (${stamp})`;

    // ── SETUP 1: the ADMIN creates the event WITH an opening message (the API-only admin-create,
    // passing openingMessage through createEvent's overrides — the real CreateEventRequest field). ──
    const adminHeaders = await authHeadersFor(ADMIN);
    const event = await createEvent(adminHeaders, {
      heading,
      capacity: 10,
      openingMessage: openingText,
    });
    expect(event.id).toBeTruthy();
    // The opening message round-trips on the created record (EventResponse.openingMessage, TM-710).
    expect(event.openingMessage).toBe(openingText);

    // ── SETUP 2: the GOER lands GOING → the real lifecycle opens the event's group thread for the
    // FIRST time (EventChatLifecycleService.onGoing), which auto-posts the opening message once as an
    // ANNOUNCEMENT. Reset first so a lingering GOING from an earlier run can't trip the one-active-event
    // guard (TM-413). ───────────────────────────────────────────────────────────────────────────────
    const goerHeaders = await resetAttendanceFor(EVENT_GOER);
    const join = await apiRsvp(goerHeaders, event.id);
    expect(join.state).toBe("GOING");

    // ── SETUP 3: a SECOND attendee (EVENT_WAITER) ALSO lands GOING on the SAME event → onGoing fires
    // AGAIN (the chat re-opens for another member). The idempotency guard (opening_message_posted_at)
    // must NOT re-post the opening message. Reset this account too so its RSVP isn't refused by the
    // one-active-event guard. Capacity is 10, so both join GOING (neither is waitlisted). ────────────
    const waiterHeaders = await resetAttendanceFor(EVENT_WAITER);
    const secondJoin = await apiRsvp(waiterHeaders, event.id);
    expect(secondJoin.state).toBe("GOING");

    // ── ASSERT (API, load-bearing idempotency): read the thread and confirm the opening-message body
    // appears in EXACTLY ONE announcement-kind message — NOT zero (it did auto-post) and NOT two (the
    // second RSVP did not duplicate it). This is the precise behaviour the opening_message_posted_at
    // stamp guarantees; before the fix there was no auto-post at all (count 0). ──────────────────────
    const conversationId = await findConversationId(goerHeaders, event.id);
    const messages = await readMessages(goerHeaders, conversationId);
    const openingAnnouncements = messages.filter(
      (m) => m.kind === "ANNOUNCEMENT" && m.body === openingText,
    );
    expect(openingAnnouncements).toHaveLength(1);
    // It is a system/host opening message (no acting author on the RSVP path), so senderId is null.
    expect(openingAnnouncements[0].senderId ?? null).toBeNull();

    // ── STEP 1 (UI): the member signs in and opens Chat — the event thread's row is in their list. ──
    // Navigate straight to the (protected) #/chat route rather than the bottom-tab-bar #tab-chat control:
    // this spec runs ONLY under the DESKTOP chromium project (its filename isn't in the mobile-chromium
    // testMatch), where #tab-chat is display:none (a mobile-width-only nav, TM-434) — clicking it timed
    // out in CI run 29499146715. The #/chat hash route renders the same #chat-view / chat.js surface at
    // any viewport, so it's the viewport-independent path the sibling chat-ios-button.spec.mjs /
    // chat-live-stream.spec.mjs use for exactly this reason. The list + row assertions below are otherwise
    // unchanged — the real chat.js data-testids (chat-list / chat-row).
    await signIn(page, EVENT_GOER);
    await page.goto("/#/chat");
    await expect(page.locator("#chat-view")).toBeVisible();
    await expect(page.locator('[data-testid="chat-list"]')).toBeVisible();
    const row = page.locator('[data-testid="chat-row"]', { hasText: heading });
    await expect(row).toBeVisible();
    await shot("member-chat-list");

    // ── STEP 2 (UI): open the thread — the opening message renders as the DISTINCT announcement card
    // ([data-testid="chat-announcement"], chat.js announcementNotice), carrying the "📣 Announcement"
    // attribution and the opening-message body — NOT as an ordinary attendee bubble
    // ([data-testid="chat-msg"]). And it renders EXACTLY ONCE in the timeline (mirrors the API count —
    // the idempotency guard again, this time as the member sees it). ─────────────────────────────────
    await row.click();
    await expect(page.locator('[data-testid="chat-thread"]')).toBeVisible();
    const card = page.locator('[data-testid="chat-announcement"]', { hasText: openingText });
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await expect(card.locator(".tm-chat-from-name")).toHaveText("Announcement");
    // And it is genuinely NOT rendered as an ordinary message bubble.
    await expect(page.locator('[data-testid="chat-msg"]', { hasText: openingText })).toHaveCount(0);
    await shot("opening-announcement-visible");
  });
});
