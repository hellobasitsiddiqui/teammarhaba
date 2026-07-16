# Story 02 — Sarah's Membership Month

Personas: **Sarah** (MONTHLY member), **Joe** (free / PAY_PER_EVENT, first-event credit already spent in story-01), **Aisha** (admin).

Exercises the paid-event checkout split (TM-476/477/478): a member gets the event **INCLUDED** with no charge, a free user gets a **PAY £8** decision, a server-priced **PENDING** order, a mock Revolut settle via webhook, and both land on the admin roster.

> Pricing rule under test (`EntitlementResolver`): MONTHLY on a standard event → `INCLUDED` (£0, `INCLUDED_MONTHLY`); PAY_PER_EVENT with credit spent → `PAY` at `events.price_pence` (`PAY_STANDARD`). The amount is always **server-computed from the event row — never taken from the client**.

## Preconditions

- Sarah's membership tier is `MONTHLY` (`POST /api/v1/me/membership/tier` as Sarah, or seeded).
- Joe's membership is `PAY_PER_EVENT` with `first_event_credit_used = true` (his freebie went on story-01's event — otherwise rule 5 would give him `FREE` here and skip the paid path).
- Payments run against the Revolut **sandbox/mock** (`revolut.apiBase` defaults to `https://sandbox-merchant.revolut.com`; membership flag ON).

## Steps

1. **Aisha creates a paid event.**
   `POST /api/v1/admin/events` — "Members' Supper Club", `pricePence: 800`, `capacity: 5`, `isPremium: false`.
   Expect: `201`, event visible in the feed (`GET /api/v1/events`) showing £8.

2. **Sarah checks her entitlement.**
   `GET /api/v1/events/{id}/entitlement` as Sarah.
   Expect: `decision: INCLUDED`, `amountPence: 0`, `reason: INCLUDED_MONTHLY`.

3. **Sarah books — frictionless.**
   `POST /api/v1/events/{id}/checkout` as Sarah.
   Expect: `paymentRequired: false`, a **CONFIRMED £0 order**, `rsvp` present with state `GOING`, and an `RSVP_CONFIRMED` notification in `GET /api/v1/me/notifications`.

4. **Joe checks his entitlement.**
   `GET /api/v1/events/{id}/entitlement` as Joe.
   Expect: `decision: PAY`, `amountPence: 800` (server-derived from `events.price_pence`), `reason: PAY_STANDARD`.

5. **Joe checks out — payment required.**
   `POST /api/v1/events/{id}/checkout` as Joe.
   Expect: `paymentRequired: true`, order status **PENDING** with `amountPence: 800`, `rsvp: null` (not confirmed until settled), and a `paymentToken` to mount the provider widget. Repeat the call: idempotent — same order back, no duplicate.

6. **Joe pays via the mock provider; webhook settles.**
   Complete the sandbox payment (or simulate: signed `ORDER_COMPLETED` webhook to `POST /api/v1/payments/revolut/webhook` carrying Joe's provider order id).
   Expect: `2xx`; `CheckoutService.confirmPayment` moves the order **PENDING → CONFIRMED** and confirms the RSVP. Replay the same webhook: idempotent no-op.

7. **Joe sees the outcome.**
   `GET /api/v1/me/orders` as Joe → order `CONFIRMED`, `amountPence: 800`. `GET /api/v1/me/notifications` → `RSVP_CONFIRMED` fired.

8. **Aisha checks the roster.**
   `GET /api/v1/admin/events/{id}` — going count = 2 (Sarah + Joe), capacity 5, so 3 spots remain; admin console roster lists both.

## Verification (3 layers)

**Layer 1 — API (as above):** entitlement decisions (steps 2/4), checkout results (3/5), order + notification reads (7), admin counts (8).

**Layer 2 — Database:**

```sql
-- Both attendance rows confirmed
SELECT user_id, state FROM event_attendance WHERE event_id = :id;          -- Sarah + Joe, state = 'GOING'

-- Orders: Sarah £0 CONFIRMED; Joe 800 CONFIRMED (was PENDING pre-webhook)
SELECT user_id, amount_pence, status FROM orders WHERE event_id = :id;

-- Amount bounds: server-computed, never client-supplied
SELECT o.amount_pence, e.price_pence FROM orders o JOIN events e ON e.id = o.event_id
WHERE o.event_id = :id AND o.user_id = :joe;                               -- 800 = 800
-- and the CHECK (amount_pence >= 0) + UNIQUE (user_id, event_id) held (no dupes, no negatives)

-- Notifications fired
SELECT user_id, type FROM notifications
WHERE type = 'RSVP_CONFIRMED' AND user_id IN (:sarah, :joe);               -- one row each
```

Capture Joe's order **before** the webhook too: `status = 'PENDING'` — the PENDING → CONFIRMED transition is the assertion, not just the end state.

**Layer 3 — UI/admin:** Aisha's admin event detail shows going = 2 with both names on the roster; Sarah's app shows the event as booked with no charge; Joe's shows it booked with an £8.00 receipt in his orders.

## Failure modes this story guards

- Client-priced orders (amount must come from `events.price_pence`, checked in Layer 2).
- RSVP confirming before payment settles (step 5's `rsvp: null`).
- Duplicate orders on checkout retry or webhook replay (idempotency in steps 5/6).
- Member being charged for an included event (step 3's £0 order).
