# Story 04 — The Sold-Out Scramble

**Personas:** Joe, Sarah, Marcus, Priya (members) · Aisha (admin/host)
**Theme:** a FREE, popular event with a tiny capacity. Everyone races to RSVP **at the same time**. This story exists to prove **contended correctness** — the `SELECT ... FOR UPDATE` capacity lock, the waitlist, and the offer cascade — under genuine concurrency. **No step in this story may assume serial arrival order.**

## Why this story is different

Stories 01–03 can pass on a serial system. This one cannot. The oracle here asserts **invariants under contention**, never identities:

- We assert **counts** (exactly `capacity` GOING, exactly `N − capacity` WAITLISTED), **never** *which* persona wins the race. Any of Joe/Sarah/Marcus/Priya may land either side — all outcomes where the invariants hold are a PASS.
- The four RSVPs must be fired **concurrently** (no awaits between them; a barrier/`Promise.all`-style start). If the harness accidentally serialises them, the run is invalid, not a pass.
- Overbooking (`GOING count > capacity`), a lost RSVP (a request that neither lands GOING nor WAITLISTED nor errors), or a double-promotion after the cancel are each an immediate FAIL.
- Freed spots are **never auto-grabbed**: a spot freed by a cancel belongs to the **offer cascade** (recorded offer → head of waitlist → explicit claim), not to whoever RSVPs next (fairness rule in `EventRsvpService`).

## Setup

| Item | Value |
|---|---|
| Event | "Rooftop Iftar Social" — **FREE**, capacity **3** |
| Racers | Joe, Sarah, Marcus, Priya — 4 concurrent RSVPs for 3 spots |
| Naming below | The 3 race winners are called **W1, W2, W3**; the loser is **L1** (bindings resolved at runtime, asserted by count only) |
| Backend anchors | `EventRsvpService` (FOR UPDATE capacity lock, `rsvp`/`cancelRsvp`/`claim`), `WaitlistOfferCascadeService` + `WaitlistOfferCascadeScheduler` (TM-393/TM-397), `EventChatLifecycleService` (TM-446), `NotificationType.WAITLIST_OFFER` / `RSVP_CONFIRMED` / `CHAT_MENTION` |

## Steps

| # | Actor | Action | Expected (oracle) | Status |
|---|---|---|---|---|
| 1 | Aisha | Create + publish the free event with capacity **3** | Event visible to members; shows 3 spots open, 0 waitlisted | LIVE ✅ |
| 2 | Joe, Sarah, Marcus, Priya | **Concurrently** RSVP (all 4 requests released together at a barrier) | All 4 requests succeed (2xx). The FOR UPDATE lock on the event row serialises the landings: **exactly 3 GOING, exactly 1 WAITLISTED** — never 4 GOING, never 2 WAITLISTED, no lost request. Identity of W1–W3/L1 is NOT asserted | LIVE ✅ |
| 3 | oracle | Re-read event state after the race | Spots remaining = 0; waitlist count = 1; each racer's own view shows their true state (winners see "Going", L1 sees waitlist position 1) | LIVE ✅ |
| 4 | W1–W3 | Free-event **voucher consumed** on each confirmed (GOING) RSVP | Each winner's voucher balance decremented exactly once (no double-spend under the same contention); L1's voucher untouched while WAITLISTED | TARGET ⏳ (depends TM-604 / TM-457) |
| 5 | W1–W3, L1 | Event group chat: the 3 GOING members are auto-joined on landing (TM-446); W1 and W2 exchange several messages while W3 is online and L1/offline members are not | Messages delivered live to online members in order; W3 (joined, app backgrounded/offline) gets **push** notifications; unread badge counts increment per member and clear on read; L1 (WAITLISTED, not a chat member) receives **nothing** | LIVE ✅ |
| 6 | W2 | **Cancels** their GOING RSVP | Cancel succeeds; GOING count drops to 2; the freed spot is **recorded for the offer cascade** — it is NOT silently given away, and a fresh RSVP from a 5th user at this instant lands WAITLISTED (behind L1), not GOING | LIVE ✅ |
| 7 | cascade | Offer cascade fires for the freed spot | **Head of the waitlist (L1)** receives a `WAITLIST_OFFER` notification (in-app + push). Exactly one live offer exists; nobody is auto-promoted | LIVE ✅ |
| 8 | L1 | **Claims** the offered spot | Claim promotes L1 WAITLISTED → GOING under the same FOR UPDATE lock; GOING count back to 3; remaining open offers voided (cascade-stop signal); L1 receives `RSVP_CONFIRMED`; L1 is auto-joined to the event chat and sees the backlog + correct unread badge. **Both parties notified**: W2 has cancel confirmation, L1 has confirmation of promotion | LIVE ✅ |
| 9 | W2, L1 | Voucher ledger settles across the cancel/promote cascade | W2's consumed voucher is **refunded** on cancel; L1's voucher is **consumed** on claim (promotion = confirm). Net event voucher spend = 3, exactly once per final GOING member | TARGET ⏳ (depends TM-604 / TM-457) |
| 10 | oracle | Race the cancel: while step 6–8 is in flight, a concurrent RSVP + a concurrent claim attempt by a non-offered member are fired | The lock keeps the invariant: at no observable instant does GOING exceed 3; the non-offered member cannot claim; the fresh RSVP lands WAITLISTED (waitlist exists → back of the queue) | LIVE ✅ |
| 11 | Aisha | At event start, records **attendance check-ins** for the members who show up (W1, W3, L1) | Each check-in recorded exactly once against the final GOING set; W2 (cancelled) cannot be checked in; admin view shows 3/3 checked in | LIVE ✅ |
| 12 | oracle | Post-event ledger sweep | Final state: 3 GOING (all checked in), 0 live offers, 0 orphaned WAITLISTED-with-offer rows, chat membership = final GOING set + admin, voucher ledger balanced per step 9 (⏳ until TM-604/TM-457) | LIVE ✅ (voucher line ⏳) |

## Contention rules for the harness (non-negotiable)

1. **Barrier start** — steps 2 and 10 must release their requests simultaneously; a serialised run does not exercise the lock and must be reported as INVALID, not PASS.
2. **Assert invariants, not winners** — any W1–W3/L1 binding is acceptable; the oracle binds names *after* the race and carries the bindings through steps 4–12.
3. **Repeat to expose flakes** — the race steps (2, 10) should run N iterations (fresh event each time); a single overbooked iteration fails the story.
4. **No sleeps as synchronisation** — wait on observable state (counts, notification rows), never on fixed delays, so the cascade timing (scheduler-driven, TM-397) is tested as-is.

## Dependencies

- **TM-604 / TM-457** — free-event voucher consume-on-confirm / refund-on-cancel: steps 4, 9 and the voucher line of step 12 are **TARGET ⏳** until these land; run them as no-op placeholders that log SKIPPED, not as passes.
- Offer-cascade mechanics per owner decision 2026-07-03: freed spots are *offered*, never auto-promoted — step 7/8 encodes offer → claim, not silent promotion.
