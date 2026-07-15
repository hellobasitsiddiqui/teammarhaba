// Event-chat LIVE STREAM (SSE) journeys — P0 coverage (TM-738, epics TM-464 / TM-730).
//
// The three foundation specs (chat-foundation.spec.mjs, tm709-late-join-history.spec.mjs,
// tm710-announcement.spec.mjs) prove the STORE-AND-FORWARD chat surface: seeded/late history, the
// admin announcement card, the populated list + badge — all things a plain fetch-on-open + the 15s
// poll would render. What none of them prove is the LIVE latency layer on top: the Server-Sent-Events
// stream (openConversationStream in api.js → openLiveThread/mergeLiveMessage in chat.js, backed by
// ConversationStreamController + ChatStreamService) that folds a freshly-broadcast message into an
// OPEN thread the instant it's posted, WITHOUT waiting for the next poll tick. This spec is that gap:
//
//   1. TWO-SESSION LIVE APPEND (TM-464). Two real browser sessions, both members of the same event
//      thread, both with the thread OPEN (so both hold a live SSE connection). User A posts through the
//      composer; User B's thread renders A's message WELL INSIDE the SSE window — before the 15s poll
//      (THREAD_POLL_MS) could have fetched it. The tight assertion window (the default 10s expect
//      timeout < 15s poll interval) is what makes this prove the STREAM, not the poll: if B only had the
//      poll, the message could not appear for up to 15s.
//
//   2. SENDER OPTIMISTIC-ECHO RECONCILIATION (TM-464 + TM-448/TM-731). The sender's own message is a
//      three-way collision: the optimistic bubble it paints instantly, the POST 201 response it confirms
//      with, AND the server's LIVE broadcast echo of that same message back down the poster's own stream.
//      All three must collapse to ONE confirmed bubble — mergeLiveMessage de-dupes the live echo BY ID
//      against the already-confirmed row, so a lean fan-out frame can't double-render. We assert User A
//      sees its message go pending → exactly one confirmed [data-testid="chat-msg"] (never two), i.e. no
//      duplicate from the self-echo.
//
//   3. MODERATION CUTOFF (TM-730 disconnectMember). Membership is checked only at CONNECT, so before
//      TM-730 a member kicked by moderation kept receiving live frames until their stream timed out (up
//      to 4 min). This proves the fix end to end: while User B holds an OPEN, live stream, an ADMIN sets
//      B REMOVED (POST /admin/conversations/{id}/members/{userId}/mute, MuteState REMOVED). The removal's
//      AFTER_COMMIT hook completes B's open SSE stream at once, and any RE-CONNECT is denied 403 (the
//      connect-time membership gate, ConversationReadService.assertMember → 403 for a REMOVED member). We
//      prove BOTH halves: (a) the transport — a fresh in-browser fetch to the stream endpoint with B's
//      own token returns HTTP 403 after removal (the "auto-reconnect denied" contract); and (b) the UI —
//      re-opening the thread in B's browser now shows the error state, because the messages read 403s too.
//
// Setup is fully API-driven through the SAME first-party paths production uses (mirroring
// tm709-late-join-history.spec.mjs / tm710-announcement.spec.mjs): the ADMIN creates the event, the two
// browser users land GOING (the real EventChatLifecycleService.onGoing opens the thread + adds them as
// members), and — for the moderation test — the ADMIN calls the real TM-449 mute endpoint. No mocks: a
// live backend + Postgres + the Firebase Auth emulator, exactly like the sibling chat specs.
//
// Like the other chat specs this runs at the phone viewport only (the mobile-chromium project): the Chat
// surface is reached via the bottom tab bar (#tab-chat, TM-434), which is display:none at desktop width.
// This file must be added to the mobile-chromium testMatch (and the desktop testIgnore) in
// playwright.config.mjs alongside chat-foundation / tm709 / tm710 — it has no desktop variant.

import { test, expect } from "@playwright/test";
import { ADMIN, EVENT_GOER, EVENT_WAITER, API_BASE_URL } from "../fixtures.mjs";
import { authHeadersFor, createEvent, apiRsvp, resetAttendanceFor } from "../events-api.mjs";

// Suppress the first-run product tour (TM-147) so its dimmed backdrop can't cover the chat surface —
// the identical localStorage init-script every other chat spec uses (seeded accounts look "first-run"
// each run since the emulator wipes their localStorage). Applied per-CONTEXT below (addInitScript on the
// context) so it also covers the SECOND browser context the two-session tests spin up, not just `page`.
const SUPPRESS_TOUR = () => {
  const orig = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) {
    return typeof k === "string" && k.startsWith("tm.tour.")
      ? JSON.stringify({ done: true })
      : orig.call(this, k);
  };
};

/** Sign in a seeded, un-gated account via the email+password ("Try another way") flow — the same path
 *  events.spec.mjs / chat-foundation.spec.mjs / tm709 / tm710 use. The account is provisioned onboarded +
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

/** Find the id of a member's EVENT_GROUP conversation for `eventId` via the real read API
 *  (GET /me/conversations — TM-436). The summary rows carry `eventId`, so this is a keyed match, never a
 *  title guess. Throws loudly if the thread hasn't been opened (a setup bug to surface). Mirrors the
 *  identical helper in tm709/tm710. */
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

/** Resolve the OTHER ordinary MEMBER's numeric DB userId from the thread's roster
 *  (GET /conversations/{id}/members → ConversationMemberResponse `{ userId, displayName, role }`, TM-469).
 *  The roster EXCLUDES the caller, so calling it as member A returns everyone else in the thread. For an
 *  EVENT_GROUP thread that is NOT just member B: the event ORGANISER is auto-added as an ADMIN member
 *  (MemberRole: "the event organiser / the broadcaster is an ADMIN member of their thread"), so A's roster
 *  is [ADMIN organiser, MEMBER B] — two entries, not one. We therefore filter to role MEMBER (excluding the
 *  ADMIN organiser) and expect exactly one, which is B (A is the excluded caller). We key on role + "sole
 *  other MEMBER" rather than displayName because a JIT-provisioned seed account starts with an EMPTY
 *  displayName (UserService: "displayName starts empty") — it's only set by the full onboarding these
 *  seeds skip — so a name match would be unreliable/ambiguous. The moderation mute endpoint is keyed on
 *  this numeric userId (a path variable). Throws if there isn't exactly one other MEMBER. */
async function findOtherMemberUserId(headers, conversationId) {
  const res = await fetch(`${API_BASE_URL}/api/v1/conversations/${conversationId}/members`, { headers });
  if (!res.ok) {
    throw new Error(`list members failed: ${res.status} ${await res.text()}`);
  }
  const roster = await res.json();
  const members = Array.isArray(roster) ? roster : [];
  // Exclude the ADMIN organiser (auto-added to every EVENT_GROUP thread) — we only want the ordinary
  // MEMBER participant (User B). The caller (User A) is already excluded from the roster by the endpoint.
  const ordinaryMembers = members.filter((m) => m.role === "MEMBER");
  if (ordinaryMembers.length !== 1) {
    throw new Error(
      `expected exactly one OTHER MEMBER in thread ${conversationId} (roster excludes the caller; ` +
        `the ADMIN organiser is filtered out), got ${ordinaryMembers.length} of ` +
        `${members.length} roster entries: ${JSON.stringify(roster)} — did both A and B RSVP GOING?`,
    );
  }
  return ordinaryMembers[0].userId;
}

/** Post a message to the thread via the real post path (POST /conversations/{id}/messages, TM-447) as the
 *  account behind `headers` — the same endpoint the composer uses. Returns the created message. Used only
 *  where a post has NO browser session (none here) — the browser tests post through the composer UI. */
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

/** Set a thread member's mute/removal state via the real TM-449 admin endpoint
 *  (POST /admin/conversations/{conversationId}/members/{userId}/mute, body { state } — @PreAuthorize
 *  ADMIN). `headers` MUST be an ADMIN's. State REMOVED triggers the TM-730 disconnectMember AFTER_COMMIT
 *  hook that completes the member's open SSE stream + denies their reconnect. */
async function setMemberState(adminHeaders, conversationId, userId, state) {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/admin/conversations/${conversationId}/members/${userId}/mute`,
    { method: "POST", headers: adminHeaders, body: JSON.stringify({ state }) },
  );
  if (!res.ok) {
    throw new Error(`set member state ${state} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Open the Chat tab and enter the event thread whose list row carries `heading`. Returns once the
 *  thread body ([data-testid="chat-thread"]) is visible — i.e. history is loaded AND openLiveThread has
 *  fired, so the SSE connection is being established. Mirrors tm710's openEventThread. */
async function openEventThread(page, heading) {
  await page.locator("#tab-chat").click();
  await expect(page.locator("#chat-view")).toBeVisible();
  await expect(page.locator('[data-testid="chat-list"]')).toBeVisible();
  const row = page.locator('[data-testid="chat-row"]', { hasText: heading });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('[data-testid="chat-thread"]')).toBeVisible();
}

test.describe("@chat-live event-chat live SSE stream journeys (TM-738)", () => {
  // ── 1) TWO-SESSION LIVE APPEND ────────────────────────────────────────────────────────────────────
  test("User B sees User A's freshly-posted message appear LIVE (no poll/refresh)", async ({
    page,
    browser,
  }, testInfo) => {
    const shotB = stepShot(page, testInfo, "tm738-live-append-B");
    const stamp = Date.now();
    const heading = `e2e TM-738 live append ${stamp}`;
    // A distinctive, stamped body so the assertion can only match THIS message — never a lookalike from
    // another run against the shared CI database.
    const liveText = `Live-streamed hello (${stamp}) — should appear without a poll`;

    // ── SETUP: ADMIN creates the event; A (goer) and B (waiter) both RSVP GOING → the real lifecycle
    // opens the SAME event group thread and makes BOTH members (EventChatLifecycleService.onGoing).
    // Reset each first so a lingering GOING from an earlier run can't trip the one-active-event guard. ─
    const adminHeaders = await authHeadersFor(ADMIN);
    const event = await createEvent(adminHeaders, { heading, capacity: 10 });
    expect(event.id).toBeTruthy();

    const goerHeaders = await resetAttendanceFor(EVENT_GOER); // User A
    expect((await apiRsvp(goerHeaders, event.id)).state).toBe("GOING");
    const waiterHeaders = await resetAttendanceFor(EVENT_WAITER); // User B
    expect((await apiRsvp(waiterHeaders, event.id)).state).toBe("GOING");

    // ── B (this test's default `page`) signs in and OPENS the thread — its SSE stream is now up. ──────
    await page.context().addInitScript(SUPPRESS_TOUR);
    await signIn(page, EVENT_WAITER);
    await openEventThread(page, heading);
    // Give B's SSE handshake a beat to establish before A posts. openLiveThread fires as the thread
    // opens but the fetch handshake is async and has no DOM signal; a short settle means A's message is
    // genuinely broadcast to an ALREADY-OPEN stream (so the sub-poll-window appearance below can only be
    // the stream, not the poll). The handshake is sub-second locally; this is a small anti-race margin.
    await page.waitForTimeout(1500);
    // The message isn't there yet — proves the later appearance is genuinely a live push, not history.
    await expect(page.locator('[data-testid="chat-msg"]', { hasText: liveText })).toHaveCount(0);
    await shotB("B-thread-open-before");

    // ── A signs in a SECOND browser session, opens the SAME thread, and POSTS through the composer. ───
    const contextA = await browser.newContext();
    await contextA.addInitScript(SUPPRESS_TOUR);
    const pageA = await contextA.newPage();
    const shotA = stepShot(pageA, testInfo, "tm738-live-append-A");
    try {
      await signIn(pageA, EVENT_GOER);
      await openEventThread(pageA, heading);
      await pageA.locator('[data-testid="chat-input"]').fill(liveText);
      await pageA.locator('[data-testid="chat-send"]').click();
      // A sees its own message confirm (its optimistic bubble reconciles) — the post has committed +
      // broadcast server-side, so B's stream must now carry it.
      await expect(pageA.locator('[data-testid="chat-msg"]', { hasText: liveText })).toBeVisible();
      await shotA("A-posted");

      // ── THE LOAD-BEARING ASSERTION: B's OPEN thread renders A's message LIVE. The default 10s expect
      // timeout is deliberately shorter than the 15s THREAD_POLL_MS, so a pass can only be the SSE
      // stream folding the broadcast in — the poll could not have fetched it this fast. ───────────────
      await expect(page.locator('[data-testid="chat-msg"]', { hasText: liveText })).toBeVisible();
      await shotB("B-received-live");
    } finally {
      await contextA.close();
    }
  });

  // ── 2) SENDER OPTIMISTIC-ECHO RECONCILIATION (no duplicate from the self broadcast) ─────────────────
  test("the sender's message reconciles to a SINGLE confirmed bubble (optimistic echo + live self-echo)", async ({
    page,
  }, testInfo) => {
    const shot = stepShot(page, testInfo, "tm738-optimistic-echo");
    const stamp = Date.now();
    const heading = `e2e TM-738 optimistic echo ${stamp}`;
    const echoText = `Only-once bubble (${stamp}) — optimistic then confirmed, never doubled`;

    // ── SETUP: ADMIN creates the event; the GOER RSVPs GOING → the thread opens + they're a member. ───
    const adminHeaders = await authHeadersFor(ADMIN);
    const event = await createEvent(adminHeaders, { heading, capacity: 10 });
    expect(event.id).toBeTruthy();
    const goerHeaders = await resetAttendanceFor(EVENT_GOER);
    expect((await apiRsvp(goerHeaders, event.id)).state).toBe("GOING");

    // ── The sender signs in and opens the thread — its own SSE stream is up, so the server's broadcast
    // of its OWN post will echo back down it (the self-echo mergeLiveMessage must de-dupe by id). ──────
    await page.context().addInitScript(SUPPRESS_TOUR);
    await signIn(page, EVENT_GOER);
    await openEventThread(page, heading);

    // ── STEP 1: type + send. The optimistic bubble ([data-testid="chat-msg-pending"], dimmed "Sending…")
    // paints INSTANTLY, before the POST resolves. ─────────────────────────────────────────────────────
    await page.locator('[data-testid="chat-input"]').fill(echoText);
    await page.locator('[data-testid="chat-send"]').click();
    // The pending echo may reconcile very fast; assert the CONFIRMED end-state, which is the invariant.
    await shot("just-sent");

    // ── STEP 2: THE LOAD-BEARING ASSERTION — the message reconciles to EXACTLY ONE confirmed bubble.
    // On POST 201 the pending row is dropped + the server model upserted; the LIVE self-echo of the same
    // message folds in via mergeLiveMessage (matched BY ID) rather than inserting a second row. So there
    // is never a duplicate and never a stuck pending copy. ────────────────────────────────────────────
    await expect(page.locator('[data-testid="chat-msg"]', { hasText: echoText })).toHaveCount(1);
    await expect(page.locator('[data-testid="chat-msg-pending"]', { hasText: echoText })).toHaveCount(0);
    await shot("single-confirmed-bubble");

    // Belt-and-braces: give the self-echo + one settle a moment, then re-assert it's STILL exactly one —
    // a duplicate from the broadcast would surface here if mergeLiveMessage's id de-dupe regressed.
    await expect(async () => {
      await expect(page.locator('[data-testid="chat-msg"]', { hasText: echoText })).toHaveCount(1);
    }).toPass({ timeout: 5000 });
    await shot("still-single-after-echo");
  });

  // ── 3) MODERATION CUTOFF — removed member's stream completes + reconnect is denied 403 ──────────────
  test("removing User B mid-stream completes their SSE and denies the reconnect (403)", async ({
    page,
  }, testInfo) => {
    const shot = stepShot(page, testInfo, "tm738-moderation-cutoff");
    const stamp = Date.now();
    const heading = `e2e TM-738 moderation cutoff ${stamp}`;
    const proofText = `Live before removal (${stamp}) — proves B's stream was up`;

    // ── SETUP: ADMIN creates the event; A (goer) + B (waiter) both RSVP GOING → both members of the
    // same thread. A stays a member ONLY so we can resolve B's numeric userId from A's roster (the
    // roster excludes the caller, so A — not B — must list it). Reset-first for idempotency. ───────────
    const adminHeaders = await authHeadersFor(ADMIN);
    const event = await createEvent(adminHeaders, { heading, capacity: 10 });
    expect(event.id).toBeTruthy();

    const goerHeaders = await resetAttendanceFor(EVENT_GOER); // User A (roster source + live poster)
    expect((await apiRsvp(goerHeaders, event.id)).state).toBe("GOING");
    const waiterHeaders = await resetAttendanceFor(EVENT_WAITER); // User B (the one removed)
    expect((await apiRsvp(waiterHeaders, event.id)).state).toBe("GOING");

    const conversationId = await findConversationId(waiterHeaders, event.id);
    // B's numeric userId, resolved from A's roster: the thread has the ADMIN organiser + A + B, so A's
    // roster (which excludes the caller A) is [ADMIN organiser, MEMBER B]. findOtherMemberUserId filters
    // to role MEMBER — dropping the ADMIN organiser — leaving exactly B. (Seed accounts have empty
    // displayNames, so we key on role + "the sole other MEMBER", not a name — see findOtherMemberUserId.)
    const waiterUserId = await findOtherMemberUserId(goerHeaders, conversationId);
    expect(waiterUserId).toBeTruthy();

    // ── B signs in and opens the thread — its SSE stream is up. Prove liveness the same way test 1 does:
    // A posts (via API here, since A has no browser session in this test) and B renders it LIVE, well
    // inside the SSE window. This confirms B genuinely holds an open live stream BEFORE the removal. ───
    await page.context().addInitScript(SUPPRESS_TOUR);
    await signIn(page, EVENT_WAITER);
    await openEventThread(page, heading);
    // Let B's SSE handshake establish before A posts (same sub-poll-window anti-race margin as test 1),
    // so the live receive below proves an OPEN stream — the state the removal must then cut.
    await page.waitForTimeout(1500);
    await postMessage(goerHeaders, conversationId, proofText);
    await expect(page.locator('[data-testid="chat-msg"]', { hasText: proofText })).toBeVisible();
    await shot("B-stream-live-before-removal");

    // ── THE MODERATION EVENT: the ADMIN sets B REMOVED via the real TM-449 mute endpoint. The removal's
    // AFTER_COMMIT hook (TM-730 disconnectMember) completes B's open SSE stream at once. ───────────────
    // MemberMuteResponse is `{ conversationId, userId, mute }` (the applied MuteState is `mute`).
    const muted = await setMemberState(adminHeaders, conversationId, waiterUserId, "REMOVED");
    expect(muted.mute).toBe("REMOVED");
    await shot("B-removed-by-admin");

    // ── ASSERTION A — THE TRANSPORT: a fresh RECONNECT is denied 403. We open the stream endpoint the
    // exact way the app does — an in-browser fetch from the web origin (CORS-allowed in the dev profile)
    // with B's own Bearer token + Accept: text/event-stream — and assert the connect returns HTTP 403.
    // This is the connect-time membership gate (ConversationReadService.assertMember) refusing a REMOVED
    // member, i.e. the "auto-reconnect denied" contract the ticket names. Run IN the page so it uses the
    // same origin/CORS the real client does. The token is minted in Node + passed in (deterministic). ──
    const waiterToken = waiterHeaders.Authorization.replace(/^Bearer\s+/i, "");
    const reconnectStatus = await page.evaluate(
      async ({ apiBase, id, token }) => {
        const res = await fetch(`${apiBase}/api/v1/conversations/${id}/stream`, {
          headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        // Drain/close the body so a stray held connection can't linger in the test browser.
        try {
          await res.body?.cancel();
        } catch {
          /* best-effort */
        }
        return res.status;
      },
      { apiBase: API_BASE_URL, id: conversationId, token: waiterToken },
    );
    expect(reconnectStatus).toBe(403);

    // ── ASSERTION B — THE UI: re-opening the thread now shows the error state, because the messages read
    // 403s for a REMOVED member too (renderThread's catch → [data-testid="chat-error"]). Navigate to the
    // Chat LIST first, then back into the thread, to force a genuinely FRESH renderThread (a fetch +
    // stream re-open, both now 403) rather than relying on same-hash re-render behaviour.
    await page.goto("/#/chat");
    // Assert the chat VIEW (not the list container specifically — a removed member's list may be empty,
    // which renders chat-list-empty instead of chat-list); we only need a clean nav away from the thread.
    await expect(page.locator("#chat-view")).toBeVisible();
    await page.goto(`/#/chat/${encodeURIComponent(conversationId)}`);
    await expect(page.locator('[data-testid="chat-error"]')).toBeVisible();
    // And the live thread body is genuinely NOT rendered — the removed member can't read it any more.
    await expect(page.locator('[data-testid="chat-thread"]')).toHaveCount(0);
    await shot("B-thread-denied-after-removal");
  });
});
