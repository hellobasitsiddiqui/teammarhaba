# EVENTS-AGENT — lane playbook

Load this when you pick up the **user-facing Events tab** lane (wave-events). Sits next to
[CROSS-AGENT.md](CROSS-AGENT.md) (sprint lifecycle + the never-merge/deploy rules — read it first) and
the other lane playbooks. Your agent name is **Events Agent**; sign every reply
`— Events Agent · wave-events-1 · Actions for you: …`.

## Your surface (and only this)

The USER-FACING Events tab and the RSVP flow — NOT the admin event console.

- **The Events tab** `#/events` — the browse/list surface (soonest-first, happening-now, city context,
  empty state) + the tab chrome (content-first heading, corner bell).
- **The event detail** `#/events/{id}` — location-reveal behaviour, going-count, RSVP-state affordances,
  the pre-reveal map placeholder, the "See similar events" way-out.
- **The RSVP / waitlist / claim flow** — RSVP→GOING, join-waitlist, claim-promoted-spot, cancel; the
  booking-cutoff / one-active-event / age-band gates.

### Files
- `web/src/assets/events-core.js` — **the pure, unit-tested decision core** (formatting, listing split,
  reveal-aware location, `rsvpControlModel`, city scope, scarcity copy, similar-events). No DOM/fetch.
- `web/src/assets/events.js` — the thin DOM shell that renders the core into `#events-view`.
- Backend (user side): `EventController` (public `GET /events`, `/events/{id}`, RSVP endpoints),
  `EventRsvpService`, `EventCard`/`EventResponse`/`EventDetail` projections.
- e2e: `web/e2e/tests/events.spec.mjs`. Unit: `web/tools/events-core.test.mjs`.

### ⚠ Shared / cross-lane boundaries (ticket + hand off, never claim)
- **`events-core.js` is SHARED with wave-home** — the Home "Events near you" feed reuses its
  listing/formatting/badge logic (e.g. `goingBadge`). Reshaping it is a cross-lane change: **coordinate
  with wave-home before touching it, and land shared-copy changes on both surfaces in one PR.**
- **The ADMIN event console / create-edit form** (`admin-events.js`, `event-form.js`,
  `admin-event-route.js`, `EventAdminController`) is the **`wave-admin-events` lane**, NOT this one.
  Admin CREATES events; you CONSUME them + let users RSVP. Bugs/features there → ticket + hand off.
  (Confirmed with Basit 2026-07-27: admin-events is a separate lane.)
- Event group chat / per-event threads → wave-chat. Pay-per-event / refund → membership/payments.
  App-shell / nav / tab-bar → app-shell lane. Interests/onboarding → wave-profile.

## Architecture contracts (keep these)

- **Pure-core split.** All decision logic lives in `events-core.js` (unit-tested under plain
  `node --test`); `events.js` only renders. Add a pure model + tests, then render it — don't put logic
  in the DOM shell.
- **Content-first chrome** (TM-909, twin of Home TM-908). `#/events` opts into `SELF_HEADED_ROUTES`
  (`shell-brand-core.js`) + `CORNER_BELL_ROUTES` (`corner-bell-core.js`) — one-line route additions —
  so the walking-skeleton brand block + hamburger are retired and the bell pins top-right. The tab heads
  with the viewer's **city** (`me.city`), and the list is **city-scoped**.
- **City scope is client-side.** `cityScopedListModel(cards, me.city)` filters the loaded listing;
  heading + list both derive from ONE model so they can't disagree (no TM-662 mismatch). The list fetch
  uses `size=100` (backend MAX_SIZE) because filtering over the default 20-item page would drop a city's
  events — a **client-side workaround**; the scale-correct backend `city` param is **TM-1040**.
- **`rsvpControlModel` is the single control model** for the detail action area (primary/secondary
  button, disabled state, honest reason copy, the `similar` CTA). The **server 409 is the real gate** —
  the client always surfaces the backend's own rejection copy. Keep additions ADDITIVE (don't change
  which actions are enabled or the reason copy).
- **Reveal-aware location** (TM-408). `locationView` hides the exact venue until the reveal boundary;
  the map slot shows a generic **paper-map placeholder** (aria-hidden, geography-free — never leaks the
  venue) pre-reveal, the platform-correct "Open in Maps" link post-reveal. `mapSlotModel` decides.
- **Honest scarcity copy** (single source in `goingBadge` + `scarcityLine`): zero-going renders NOTHING
  (never "Be the first to go"); counts are bucketed (`Last few spots left` / `Last spot left` / `Full`),
  never an exact spot number. All render sites skip the empty badge.

## Gotchas that cost real time

- **Reshaping the chip/filter row or `goingBadge` = migrate ALL consumers** — the Home feed
  (`home-core.js`/`home.js`) + every e2e/capture spec. A shared-copy change must update both surfaces
  and their tests in one PR (get wave-home's ack).
- **e2e city seeding.** `web/e2e/global-setup.mjs` seeds `city: "London"` on every provisioned account
  so the city-scoped tab shows the London-seeded events (`createEvent` defaults `city:"London"`). A spec
  that provisions its own account inline (e.g. `payment-webhook-safety`) must seed a city too, or the
  content-first tab renders its no-city empty state and the browse assertions fail.
- **The `size=100` client filter** is a stopgap; if the catalogue outgrows one page a city loses events
  → TM-1040 (backend filter) is the real fix.
- **Reshaping shared UI = migrate capture scripts too**, not just `web/e2e/tests/*` (capture/evidence
  scripts outside the testDir are the classic miss).

## Testing this lane

- Unit: `node --test web/tools/*.test.mjs` (the `events-core` suite is the bulk; keep it green).
- **Branch e2e is the merge gate** — dispatch `e2e.yml --ref <branch>` yourself and confirm `success`
  on that head's SHA. `gh pr checks` alone does NOT run e2e. A red on your own new spec is often a real
  bug (the TM-1032 first run caught the client-side pagination gap).
- Evidence: before/after screenshots at **390px** attached to the ticket before In Review (before = live
  prod / main-run capture, after = branch e2e capture). Curate ≤10 scoped shots; never point the
  full-matrix `evidence_ticket=` dump at a feature ticket.

## Never do

Never merge, never deploy, never close a sprint — those are Basit's. Drive tickets
To Do → In Progress → In Review → Testing yourself; poll for the merge on a backoff. No AI-attribution
lines in PRs/commits.

## Lane map (as of wave-events-1 close, 2026-07)

Shipped in wave-events-1: **TM-909** (content-first chrome + city scope), **TM-1033** (honest scarcity
copy), **TM-1032** (paper-map placeholder), **TM-1034** (disabled-RSVP → "See similar events"). Gate
tickets TM-1035/1036/1037.

Open follow-ups (this lane): **TM-1039** (headerBar a11y double-announce), **TM-1040** (backend city
filter — retires the `size=100` stopgap), **TM-1078** (category pre-filter chips — blocked by the
admin-side taxonomy **TM-219**). The rest of the events board (recurring, roster, rich city model,
event-form bugs, admin map) is the **wave-admin-events** lane — hand off, don't claim.
