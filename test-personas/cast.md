# TeamMarhaba — Test Persona Cast

A small, reusable cast for **role-based journey / agent-based simulation testing** (TM-628). Each persona has a seeded identity, a device token (for push assertions), a membership state, and a behaviour pattern chosen to exercise a specific slice of the system. Avatars live in `avatars/<id>.svg`.

| Persona | Age | Role | Membership | What they exercise |
|---|---|---|---|---|
| **Joe Okafor** | 18 | User | Free | Keen regular; RSVPs early, drops + rejoins → cancel → waitlist cascade → re-RSVP |
| **Sarah Bennett** | 32 | User | Monthly member | Reliable, ~monthly; the paid-member **INCLUDED** event path |
| **Marcus Reid** | 45 | User | Free | Always a little late → **waitlist** → offer-cascade promotion |
| **Priya Sharma** | 25 | User | Premium | Premium perks — attendee photos + premium late-cancel (TM-602) |
| **Aisha Khan** | 38 | Admin / Host | Staff | Creates events (free/paid, age-gated/open); eyeballs roster, attendance, notifications |

## The characters

- **Joe Okafor (18, free).** The keen fresher who's at everything — first to hit RSVP, but flaky: he'll drop out and rejoin on a whim. He's the engine for the cancel → waitlist-cascade → re-RSVP path, and (being 18) the boundary case for age-gated events.
- **Sarah Bennett (32, monthly member).** Reliable, comes about once a month. Her membership makes paid events **INCLUDED** (no charge), so she's the "member gets in free, order is £0" oracle.
- **Marcus Reid (45, free).** Always books a beat too late, so he lands on the **waitlist** — the actor who *should* get auto-promoted when someone drops. Tests offer-cascade fairness (head-of-queue wins).
- **Priya Sharma (25, premium).** The premium tier — she can see the attendee-photo strip and late-cancel a non-premium event freely (TM-602). The oracle for premium-gated perks *and* that the server withholds those from non-premium users.
- **Aisha Khan (38, admin / host).** The organiser. Creates the events (free/paid, age-gated/open), then eyeballs the roster, attendance check-ins and notification history to confirm reality matches the story. *(A dedicated "host" role doesn't exist yet — she acts as host via admin; flagged in TM-628.)*

> **Oracle convention (used by every story):** each step verifies three layers — **UI** (what the actor sees), **Server** (API response + DB row/state), **Side-effects** (notification/push, chat delivery, `audit_events`). A step passes only when all three agree. Steps marked ⏳ are *target* oracles that depend on unbuilt features (vouchers → TM-604/TM-457; premium perks → TM-602).
