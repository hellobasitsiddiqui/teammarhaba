# Story 01 — The Willen Lake Walk (free, capacity 2, age-open)

Personas: **Joe** (free), **Sarah** (member — attends as a normal user here), **Marcus** (free), **Aisha** (admin).

Exercises the full RSVP lifecycle on a **free** event: create → confirm → capacity full → waitlist → cancel → **offer-cascade promotion** → re-RSVP → per-event chat → attendance → voucher reconciliation. This is the flagship contended-correctness story.

Oracle: every step verifies **UI** · **Server** (API + DB) · **Side-effects** (notification/push, chat, `audit_events`).

## Setup

**Aisha creates the event.** `POST /api/v1/admin/events` — "Willen Lake Walk", `pricePence: 0` (free), `capacity: 2`, age-open, starts in 2h.
- **UI:** appears in the events feed showing **Free**.
- **Server:** an `events` row, `price_pence = 0`, `capacity = 2`.
- **Side-effects:** an `audit_events` "event created" entry.

## Steps

1. **Joe RSVPs — slot 1 of 2.**
   - **UI:** "You're going", roster **1/2**.
   - **Server:** `event_attendance(joe, event, CONFIRMED)`; `GET /events/{id}` roster contains Joe.
   - **Side-effects:** a `notification` "RSVP confirmed" for Joe + a push attempted to Joe's device token. ⏳ free-event voucher balance −1.

2. **Sarah RSVPs — slot 2 of 2 → FULL.**
   - **UI:** "You're going"; event now shows **Full**, roster **2/2**.
   - **Server:** `event_attendance(sarah, CONFIRMED)`; capacity reached.
   - **Side-effects:** confirmation notification + push to Sarah.

3. **Marcus RSVPs late → WAITLISTED.**
   - **UI:** "You're on the waitlist (#1)".
   - **Server:** `event_attendance(marcus, WAITLISTED)`, position 1; confirmed roster still 2/2.
   - **Side-effects:** a "you're on the waitlist" notification to Marcus (**not** a confirmation).

4. **Joe drops out → cascade promotes Marcus.**
   - **UI:** Joe sees "You've cancelled"; Marcus's app flips to "You're going".
   - **Server:** Joe's row → `CANCELLED`; under the `FOR UPDATE` capacity lock the offer cascade promotes Marcus → `event_attendance(marcus, CONFIRMED)`; roster back to 2/2 (Sarah + Marcus).
   - **Side-effects:** **two** notifications — Joe "cancelled" + Marcus "a spot opened — you're in!", each with push; `audit_events` records the cascade.

5. **Joe rejoins → event full → Joe WAITLISTED.**
   - **UI:** Joe now sees "On the waitlist (#1)" (roles reversed with Marcus).
   - **Server:** `event_attendance(joe, WAITLISTED)`; **no ghost/duplicate rows** from the drop+rejoin.
   - **Side-effects:** a waitlist notification to Joe.

6. **Chat — the confirmed attendees message.**
   - Sarah + Marcus open the event chat; Sarah sends "See you at the boathouse!", Marcus replies.
   - **UI:** both see both messages in order; Joe (waitlisted) sees the chat only if the event's `include_waitlist_in_chat` is on — assert per that setting.
   - **Server:** two `message` rows on the event `conversation`; membership = the confirmed attendees.
   - **Side-effects:** each message delivered **live via SSE** + sets an **unread badge** + a push to the offline party; `mark-read` clears the badge.

7. **Attendance — check-in at start.**
   - Sarah + Marcus check in (GPS attendance).
   - **UI:** "Checked in ✓".
   - **Server:** attendance recorded (`event_attendance.attended = true`) for both.
   - **Side-effects:** the admin dashboard attendee count updates; `audit_events` entry.

8. **Aisha eyeballs everything (admin oracle).**
   - **UI:** the admin roster shows Sarah + Marcus **confirmed & attended**, Joe **waitlisted**, and the full timeline.
   - **Server:** all rows match the above.
   - **Side-effects:** the sent-history reflects exactly the notifications that fired — no more, no fewer.

9. **⏳ Voucher reconciliation (target — depends on TM-604/TM-457).**
   - Joe's free-event voucher (consumed at Step 1) is **refunded** on his Step-4 cancel; Marcus's is consumed on promotion.
   - Written now, activated when the voucher/credit primitive lands.
