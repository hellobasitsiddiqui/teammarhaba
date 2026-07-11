# Story 03 — Priya's Premium Perks

**Personas:** Priya (premium member), Joe (free member), Aisha (admin)
**Depends on:** **TM-602** (premium perks: attendee-photo gate + premium-only late cancel) — **NOT BUILT** (spike, To Do). All oracles that depend on it are marked **TARGET ⏳**.
**Also exercises (built today):** attendee strip (TM-393), cancellation window + strike count (TM-414), waitlist offer cascade (TM-430), `Event.premium` flag (TM-475), membership paid path behind `MEMBERSHIP_ENABLED` (TM-633).

## Oracle legend

| Marker | Meaning |
|---|---|
| **BUILT ✅** | Behaviour exists in `main` today — the agent asserts it now; a failure is a regression. |
| **TARGET ⏳** | Expected behaviour **once TM-602 ships** — not built yet. The agent records the current (pre-gate) behaviour as baseline and flips the oracle to enforcing when TM-602 lands. Do **not** fail the run on these today. |

## Preconditions / seed

- Non-prod target with `MEMBERSHIP_ENABLED=true`.
- **Priya** — seeded user with an **active premium membership** (entitlement per TM-457; until the entitlement reader exists, seed via the membership stub/test hook).
- **Joe** — seeded free user, **no** membership, `lateCancelCount = 0` (check `GET /api/v1/me`).
- **Aisha** — ADMIN (role claim).
- **W** — one seeded pool user (any `user-pool-*` identity) used only to occupy the waitlist.
- Clock: run inside the late-cancellation window (event starts < the effective cutoff — per-event override → per-city → app default, TM-414). Use the test clock (TM-622) rather than real waiting.

## Steps

Each step: **actor → action → oracle(s)**. Verify oracles **server-side via the API** (raw JSON), not by looking at the UI — the whole point of Rule 1 is that client-hiding is not enforcement.

1. **Aisha creates the stage.** As admin, create a **NON-premium** event (`premium = false`, default £5 `pricePence`, **capacity 2**), starting inside the late-cancel window (test clock).
   - **Oracle — BUILT ✅:** `POST` succeeds; `GET /api/v1/events/{id}` shows `premium: false`, `capacity: 2`.

2. **Priya and Joe both RSVP GOING; W joins the waitlist.** Priya RSVPs, Joe RSVPs (event now full), W RSVPs.
   - **Oracle — BUILT ✅:** Priya + Joe land `GOING`; W lands `WAITLISTED`; `goingCount = 2`, `waitlistCount = 1`.

3. **Priya (premium) sees the attendee-photos strip.** Priya fetches the event detail.
   - **Oracle — BUILT ✅:** the attendee strip data (`AttendeeAvatar` list: `id` + `displayName`) is present in her event-detail response (TM-393 renders it for members today).
   - **Oracle — TARGET ⏳ (TM-602 Rule 1):** it **remains** present for her *because she is premium* once the gate lands — re-assert post-TM-602 that premium status, not mere membership of the surface, is what grants it.
   - Note (TM-602 open question): "photos" are currently initials/placeholder art, not real avatars — assert the strip payload, not pixel content.

4. **Joe (free) gets the gated view — and the server must not even send him the list.** Joe fetches the same event detail and the agent inspects the **raw JSON response**.
   - **Oracle — TARGET ⏳ (TM-602 Rule 1, server-side):** Joe's payload contains **no attendee identities** — no `AttendeeAvatar` entries, no ids, no display names anywhere in the body. He may receive a gated projection only (count-only or blurred/upsell placeholder, per the TM-602 product decision). Enforcement lives in the projection (`EventQueryService` / DTO), **never** client-side hiding — grep the raw body, not the DOM.
   - **Oracle — TARGET ⏳:** the gated view carries an upgrade/upsell affordance (ties to TM-457 checkout).
   - **Baseline today:** Joe receives the full strip (pre-gate). Record it; do not fail.

5. **Priya late-cancels freely.** Inside the window, Priya calls `DELETE /api/v1/events/{id}/rsvp`.
   - **Oracle — BUILT ✅:** cancel succeeds; `CancelResult.lateCancel = true`; her `GOING` slot is freed.
   - **Oracle — TARGET ⏳ (TM-602 Rule 2):** as a premium member she is **not blocked and not penalised** on a non-premium event. Whether her `lateCancelCount` strike still increments is an open TM-602 decision — assert whichever is decided; until then, record the observed value.

6. **The waitlist advances off Priya's freed slot.** Immediately after step 5.
   - **Oracle — BUILT ✅:** W receives a **`WAITLIST_OFFER`** notification (check W's notifications feed / push route) and the cascade offers W the freed slot; event `waitlistCount` drops accordingly.
   - **Oracle — TARGET ⏳:** a **premium** late cancel must still free the slot for the cascade post-TM-602 (per the ticket's waitlist-fairness interaction) — re-assert this step is unchanged by the gate.

7. **Joe's late cancel is blocked/penalised.** Joe calls `DELETE /api/v1/events/{id}/rsvp` inside the window on the non-premium event.
   - **Oracle — TARGET ⏳ (TM-602 Rule 2):** the late cancel is **rejected or penalised** (block vs penalty is the open TM-602 decision) with a clear, upsell-aware `application/problem+json` error — not a silent 200. If blocked: his RSVP stays `GOING`, no `WAITLIST_OFFER` fires, and he must not silently lose the £5 with no path (refund interaction, TM-457).
   - **Oracle — TARGET ⏳:** if the penalise route is chosen instead, `GET /api/v1/me` shows `lateCancelCount` incremented and the response says so.
   - **Baseline today (BUILT ✅):** the late cancel is *allowed but counted* — `lateCancel = true` and `lateCancelCount` increments (TM-414). Record as baseline.

8. **Aisha always sees attendees.** Aisha fetches the event detail as admin.
   - **Oracle — TARGET ⏳ (TM-602):** admin/organiser view is exempt from the gate — full attendee list regardless of premium status.

9. **Notifications sweep.** Each persona checks their notifications feed.
   - **Oracle — BUILT ✅:** W has the `WAITLIST_OFFER` from step 6; nobody received an `EVENT_CANCELLED` (the event itself was never cancelled — only RSVPs).
   - **Oracle — TARGET ⏳:** Joe's blocked cancel produced **no** waitlist movement and no spurious notifications.

10. **Audit trail (post-TM-602).**
    - **Oracle — TARGET ⏳:** the gating decisions (attendee-list gate hit, late-cancel block) are audited per TM-102, and attendee-DTO changes went through OpenAPI.

## Cross-checks (run after all steps)

- **BUILT ✅** — final state: Priya not attending, Joe `GOING` (post-TM-602: because his cancel was blocked; today: cancelled — baseline diverges, that is expected), W `GOING` or holding an active offer.
- **TARGET ⏳** — replay step 4 against a **premium** event as a thought-check only: TM-602 leaves both rules on premium events as an open product decision; do not assert.
