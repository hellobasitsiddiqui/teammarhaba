// Late-join chat history — LIVE evidence (TM-709).
//
// Proves, through the real UI against a live backend + Postgres (no mocks), that a member who joins
// an event chat AFTER messages were posted still sees that pre-join history. The backend's thread
// timeline (GET /conversations/{id}/messages → ConversationReadService.messages) deliberately does
// NOT filter by the member's joinedAt — joinedAt only scopes read receipts (TM-463) — so a late
// joiner gets the full history; this spec is the browser-level proof of that behaviour.
//
// Setup is fully API-driven through the SAME first-party paths production uses (no seed-endpoint
// change needed):
//   1. ADMIN creates an event (POST /api/v1/admin/events — events-api.mjs, as events.spec.mjs does).
//   2. EVENT_FILLER RSVPs GOING → the event's group thread opens (EventChatLifecycleService.onGoing,
//      the real event-RSVP → conversation-membership path).
//   3. EVENT_FILLER posts two distinctive messages via the real post path
//      (POST /api/v1/conversations/{id}/messages — MessagePostService, TM-447).
//   4. ONLY THEN does EVENT_GOER RSVP GOING → a genuine late joiner: their conversation_member row's
//      joinedAt is stamped strictly after those messages' created_at.
//   5. The browser signs in as EVENT_GOER, opens Chat → the thread, and asserts the PRE-JOIN message
//      BODIES are visible — the load-bearing assertion — with a named screenshot trail for the ticket.
//
// Like chat-foundation.spec.mjs (TM-587) this runs at the phone viewport only (the mobile-chromium
// project): the Chat surface is reached via the bottom tab bar (#tab-chat, TM-434), which is
// display:none at desktop width — see playwright.config.mjs.

import { test, expect } from "@playwright/test";
import { ADMIN, EVENT_GOER, EVENT_FILLER, API_BASE_URL } from "../fixtures.mjs";
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
 *  events.spec.mjs / chat-foundation.spec.mjs use. The account is provisioned onboarded +
 *  terms-accepted in global-setup, so it lands straight in the app (no first-run gate). */
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

/** Post a message to the thread via the real post path (POST /conversations/{id}/messages, TM-447)
 *  as the account behind `headers` — the same endpoint the composer uses. Returns the created message. */
async function postMessage(headers, conversationId, bodyText) {
  const res = await fetch(`${API_BASE_URL}/api/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body: bodyText }),
  });
  if (res.status !== 201) {
    throw new Error(`post message failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

test.describe("@chat-late-join a late joiner sees pre-join history (TM-709)", () => {
  test("messages posted BEFORE a member joins the event chat are visible to them in the thread", async ({
    page,
  }, testInfo) => {
    const shot = stepShot(page, testInfo, "tm709-late-join");
    const stamp = Date.now();
    const heading = `e2e TM-709 late join ${stamp}`;
    // Distinctive, stamped bodies so the UI assertion can only match THESE messages — never a
    // lookalike from another run against the shared CI database.
    const preJoinMsg1 = `Pre-join message one (${stamp}) — posted before the late joiner arrived`;
    const preJoinMsg2 = `Pre-join message two (${stamp}) — also before they joined`;

    // ── SETUP 1: the ADMIN creates the event (the API-only admin-create, as events.spec.mjs). ────
    const adminHeaders = await authHeadersFor(ADMIN);
    const event = await createEvent(adminHeaders, { heading, capacity: 10 });
    expect(event.id).toBeTruthy();

    // ── SETUP 2: the FILLER lands GOING → the real lifecycle opens the event's group thread and
    // makes them a member (EventChatLifecycleService.onGoing — the production RSVP path). Reset
    // first so a lingering GOING from an earlier run can't trip the one-active-event guard (TM-413).
    const fillerHeaders = await resetAttendanceFor(EVENT_FILLER);
    const fill = await apiRsvp(fillerHeaders, event.id);
    expect(fill.state).toBe("GOING");

    // ── SETUP 3: the FILLER posts the PRE-JOIN messages through the real post path (TM-447). ─────
    const conversationId = await findConversationId(fillerHeaders, event.id);
    await postMessage(fillerHeaders, conversationId, preJoinMsg1);
    await postMessage(fillerHeaders, conversationId, preJoinMsg2);

    // ── SETUP 4: ONLY NOW does the GOER RSVP → a genuine late joiner, their joinedAt stamped
    // strictly after the two messages' created_at. Same reset-first idempotency as the filler. ────
    const goerHeaders = await resetAttendanceFor(EVENT_GOER);
    const join = await apiRsvp(goerHeaders, event.id);
    expect(join.state).toBe("GOING");

    // ── STEP 1: the late joiner signs in and opens Chat — the new thread's row is in their list. ──
    await signIn(page, EVENT_GOER);
    await shot("signed-in");
    await page.locator("#tab-chat").click();
    await expect(page.locator("#chat-view")).toBeVisible();
    await expect(page.locator('[data-testid="chat-list"]')).toBeVisible();
    const row = page.locator('[data-testid="chat-row"]', { hasText: heading });
    await expect(row).toBeVisible();
    await shot("chat-list-row");

    // ── STEP 2: open the thread — the LOAD-BEARING assertion: both PRE-JOIN message BODIES are
    // visible to the late joiner, even though they were posted before their joinedAt. ─────────────
    await row.click();
    await expect(page.locator('[data-testid="chat-thread"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-msg"]', { hasText: preJoinMsg1 })).toBeVisible();
    await expect(page.locator('[data-testid="chat-msg"]', { hasText: preJoinMsg2 })).toBeVisible();
    // The composer is the member thread chrome (TM-448) — proves this is the real, live member view.
    await expect(page.locator('[data-testid="chat-composer"]')).toBeVisible();
    await shot("history-visible");
  });
});
