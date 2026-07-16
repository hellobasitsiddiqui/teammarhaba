// Persona Story 01 — "The Willen Lake Walk" (TM-636 / TM-628).
//
// Executable SEED for the flagship persona story: a free, capacity-2 event exercised through the full
// RSVP lifecycle — confirm → full → waitlist → cancel → offer-cascade promotion → re-RSVP — with the
// per-event chat + attendance beats stubbed for follow-up.
//
// PERSONA → seeded account map (reuse the existing TM-400 events cast in fixtures.mjs):
//   Aisha (admin)  → ADMIN
//   Joe   (goer)   → EVENT_GOER    — RSVPs, drops, rejoins
//   Marcus (waiter)→ EVENT_WAITER  — lands on the waitlist, is promoted on Joe's drop
//   Sarah (filler) → EVENT_FILLER  — fills the 2nd slot so the event is FULL (member-perks are Story 02)
//
// The Server + Side-effect oracles (DB rows: event_attendance state, notifications) are asserted for
// real via pg. The UI-layer assertions and the admin create-event step depend on selectors this seed
// can't verify without the running app, so they are explicit // TODO(harness) markers rather than
// fake passes. Schema names (event_attendance.state, its enum values) are the ones referenced across
// the event package — confirm against the live migration when wiring this up.

import { test, expect } from "@playwright/test";
import pg from "pg";
import { ADMIN, EVENT_GOER, EVENT_WAITER, EVENT_FILLER, dbConfig } from "../fixtures.mjs";

/** Sign a persona in via the real login form (same flow as the other specs). */
async function signIn(page, acct) {
  await page.goto("/#/login");
  await page.fill("#email", acct.email);
  // Email-code is the default front door (TM-234): the email+password form (#password / #signin-btn)
  // is hidden until "Try another way" reveals it — same as every other password-based spec (TM-782).
  await page.click("#try-another-btn");
  await page.fill("#password", acct.password);
  await page.click("#signin-btn");
  await expect(page.locator("#signout-btn")).toBeVisible();
}

/** Run a query against the same Postgres the stack uses; always closes the client. */
async function withDb(fn) {
  const client = new pg.Client(dbConfig);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The attendance state for (email, eventId), or null if there's no row.
 * NOTE: confirm the exact column name/enum against the event_attendance migration — the event package
 * models AttendanceState = CONFIRMED | WAITLISTED (+ cancelled tombstone).
 */
async function attendanceState(eventId, email) {
  return withDb(async (c) => {
    const { rows } = await c.query(
      `SELECT ea.state
         FROM event_attendance ea
         JOIN users u ON u.id = ea.user_id
        WHERE ea.event_id = $1 AND lower(u.email) = lower($2)
        ORDER BY ea.id DESC
        LIMIT 1`,
      [eventId, email],
    );
    return rows[0]?.state ?? null;
  });
}

/** Whether a notification row exists for this user + event (the confirmation/waitlist/cascade pings). */
async function notificationCount(eventId, email) {
  return withDb(async (c) => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n
         FROM notification n
         JOIN users u ON u.id = n.user_id
        WHERE lower(u.email) = lower($1) AND n.metadata::text LIKE '%' || $2 || '%'`,
      [email, String(eventId)],
    );
    return rows[0]?.n ?? 0;
  });
}

test("Story 01 — Willen Lake Walk: RSVP → full → waitlist → cascade → re-RSVP", async ({ page }) => {
  // --- Setup: Aisha creates the free, capacity-2 event -------------------------------------------
  // TODO(harness): drive the admin create-event flow (or a seed endpoint) as ADMIN and capture the id.
  //   e.g. sign in as ADMIN, open the admin events screen, create "Willen Lake Walk" price 0 capacity 2.
  await signIn(page, ADMIN);
  let eventId; // = <created event id>
  test.skip(eventId === undefined, "TODO(harness): wire admin create-event + capture eventId");

  // --- Step 1: Joe RSVPs → CONFIRMED (slot 1/2) --------------------------------------------------
  await signIn(page, EVENT_GOER);
  // TODO(harness): navigate to the event + click RSVP (verify the event-detail selectors).
  expect(await attendanceState(eventId, EVENT_GOER.email)).toBe("CONFIRMED"); // Server
  expect(await notificationCount(eventId, EVENT_GOER.email)).toBeGreaterThan(0); // Side-effect

  // --- Step 2: Sarah fills slot 2/2 → FULL ------------------------------------------------------
  await signIn(page, EVENT_FILLER);
  // TODO(harness): RSVP as Sarah.
  expect(await attendanceState(eventId, EVENT_FILLER.email)).toBe("CONFIRMED");

  // --- Step 3: Marcus RSVPs late → WAITLISTED ---------------------------------------------------
  await signIn(page, EVENT_WAITER);
  // TODO(harness): RSVP as Marcus; UI should show "on the waitlist".
  expect(await attendanceState(eventId, EVENT_WAITER.email)).toBe("WAITLISTED");

  // --- Step 4: Joe drops → offer cascade promotes Marcus ----------------------------------------
  await signIn(page, EVENT_GOER);
  // TODO(harness): cancel Joe's RSVP.
  expect(await attendanceState(eventId, EVENT_WAITER.email)).toBe("CONFIRMED"); // Marcus promoted
  expect(await notificationCount(eventId, EVENT_WAITER.email)).toBeGreaterThan(0); // "a spot opened"

  // --- Step 5: Joe rejoins → FULL → Joe WAITLISTED ----------------------------------------------
  // TODO(harness): re-RSVP as Joe.
  expect(await attendanceState(eventId, EVENT_GOER.email)).toBe("WAITLISTED");

  // --- Steps 6–9: chat send/receive, attendance check-in, voucher reconciliation ----------------
  // TODO(harness): open the event chat (Sarah + Marcus), assert two message rows + live delivery.
  // TODO(harness): GPS attendance check-in → event_attendance.attended = true.
  // TODO(⏳ TM-604/TM-457): voucher consumed on confirm + refunded on cancel.
});
