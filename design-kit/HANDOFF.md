# TeamMarhaba — Design System & Screens Handoff

Handoff for a design agent picking up TeamMarhaba's UI. **Exact values, not summaries.**

> **Read this first.** This repo is a **planning + wireframe repo only** — there is **no application source** in it (`web/`, `apps/`, `src/`, `*.tsx`, `*.java`, `package.json` all absent; deleted for a ticket-driven replay per `REPLAY.md`; live code lives in GitHub `hellobasitsiddiqui/teammarhaba`). The file `web/src/assets/styles.css` referenced in a wireframe comment **does not exist here** — it's a reference pointer only. **The wireframes ARE the de-facto product spec** — there is no separate prose spec for the meetup app. The **`paper` theme (42 screens) is the canonical, near-complete product surface**; treat it as source of truth.

TeamMarhaba is a **local social-meetup app** — "find your people, plan the meetup." Sample data is Milton Keynes-flavoured (Willen Lake, Big Rock Bletchley).

---

## 0. Export status (Claude Design)

All **63** `@dsCard`-marked cards were uploaded to the Claude Design design-system project:

- **Project:** "Design System" — `019de417-7860-7705-9c6b-e519c7a3bfa7` — https://claude.ai/design/p/019de417-7860-7705-9c6b-e519c7a3bfa7
- **Exported (63):** the 9 mono components, `landing`, the 11 `app-*` sketch screens, the 42 `paper-*` screens.
- **NOT exported (local indexes, no `@dsCard` marker):** `design-kit/gallery.html`, `design-kit/showcase.html`, `design-kit/showcase-paper.html`. Also not in the kit: `proof-illustrated-style.html` (style spike at repo root).
- Sync state is pinned in `design-kit/.design-sync/config.json` + `NOTES.md`. (Project currently shows the "Set up your design system" onboarding until activated in the UI.)

---

## 1. Inventory

Every card is a self-contained static HTML file at `design-kit/<path>` with a first line `<!-- @dsCard group="..." [name="..."] -->`. Fonts load from Google Fonts CDN.

### Mono marketing kit — generic "TRADE" SaaS, **lorem-ipsum placeholder** (not product copy)
| Path | Group | Purpose |
|---|---|---|
| `components/buttons-cards/index.html` | Foundations | Button + card primitives |
| `components/hero/index.html` | Sections | Split + centered hero variants |
| `components/social-proof/index.html` | Sections | Logo wall + testimonial |
| `components/features/index.html` | Sections | Image+text feature rows |
| `components/pricing/index.html` | Sections | 3-column pricing cards |
| `components/posts/index.html` | Sections | Blog / post-stack / card grid |
| `components/cta/index.html` | Sections | 3 call-to-action blocks |
| `components/navigation/index.html` | Navigation | 4 top-nav bar layouts |
| `components/footer/index.html` | Navigation | Columns + centered social footer |
| `pages/landing/index.html` | Pages | Full generic marketing landing (lorem) |

### App screens — **sketch** theme (`group="App screens"`, `html data-theme="sketch"`) — 11
Every one has a `paper-*` twin (sketch is a strict subset — see §5).
| Path | Purpose |
|---|---|
| `pages/app-home/index.html` | Events-near-you feed + bottom tab bar |
| `pages/app-events-list/index.html` | Filterable events list w/ category chips |
| `pages/app-event-detail/index.html` | Event: time, venue-reveal note, attendees, map, RSVP |
| `pages/app-gps-attendance/index.html` | Mid-event "You're here?" confirm-by-location/host-code modal |
| `pages/app-notifications/index.html` | Notifications grouped per event |
| `pages/app-chat-list/index.html` | Per-event chat inbox |
| `pages/app-chat-thread/index.html` | Group thread w/ delivery ticks + reactions |
| `pages/app-membership/index.html` | Membership tier cards |
| `pages/app-checkout/index.html` | Dummy Stripe-style checkout (first event £0.00) |
| `pages/app-profile/index.html` | Profile: completeness bar, interests, menu |
| `pages/app-admin-notify/index.html` | Admin push composer w/ audience + preview |

### App screens — **paper** theme (`group="App screens · paper"`) — 42 (canonical set)
| Path | Purpose |
|---|---|
| `pages/paper-home/index.html` | Events feed (parity w/ app-home) |
| `pages/paper-events-list/index.html` | Filterable events list |
| `pages/paper-event-detail/index.html` | Event detail + venue-reveal + RSVP |
| `pages/paper-my-events/index.html` | Upcoming / Past tabs w/ RSVP status |
| `pages/paper-search/index.html` | Search/discover w/ filters + popular |
| `pages/paper-map/index.html` | Map w/ numbered pins + event sheet |
| `pages/paper-create-event/index.html` | Admin event creation/edit form |
| `pages/paper-suggest-venue/index.html` | Group venue-suggestion form (votable) |
| `pages/paper-event-cancelled/index.html` | Host-cancelled banner + refund note |
| `pages/paper-rsvp-confirmed/index.html` | "You're going!" success + add-to-calendar |
| `pages/paper-claim-spot/index.html` | Waitlist "spot opened" claim modal + timer |
| `pages/paper-gps-attendance/index.html` | Location/host-code attendance modal |
| `pages/paper-attendance-result/index.html` | "You're marked present" confirmation |
| `pages/paper-notifications/index.html` | Grouped notifications |
| `pages/paper-chat-list/index.html` | Chat inbox |
| `pages/paper-chat-thread/index.html` | Group thread w/ ticks + reactions |
| `pages/paper-chat-empty/index.html` | "No messages yet" first-message prompt |
| `pages/paper-reaction-picker/index.html` | Long-press emoji reaction picker |
| `pages/paper-report/index.html` | Report-a-person sheet + block |
| `pages/paper-membership/index.html` | Membership tier cards |
| `pages/paper-checkout/index.html` | Dummy checkout |
| `pages/paper-payment-methods/index.html` | Saved cards + Apple Pay + add card |
| `pages/paper-payment-result/index.html` | Payment-successful receipt |
| `pages/paper-credits/index.html` | Free-credit balance + history |
| `pages/paper-signin/index.html` | Email-code / Google / phone sign-in |
| `pages/paper-verify/index.html` | 4-digit OTP entry + resend timer |
| `pages/paper-complete-profile/index.html` | Onboarding step 1/2 (name/age/city) |
| `pages/paper-pick-interests/index.html` | Onboarding step 2/2 (interest chips, max 5) |
| `pages/paper-empty-home/index.html` | Zero-events first-run empty state |
| `pages/paper-invite/index.html` | Referral link + earned-credit stats |
| `pages/paper-profile/index.html` | Own profile |
| `pages/paper-edit-profile/index.html` | Editable name/age/city/bio/interests |
| `pages/paper-public-profile/index.html` | Another user's profile + "in common" |
| `pages/paper-settings/index.html` | Notifications/appearance/account toggles |
| `pages/paper-privacy-data/index.html` | GDPR consent toggles + export/delete |
| `pages/paper-admin-dashboard/index.html` | Admin KPIs + quick actions + recent |
| `pages/paper-admin-events/index.html` | Manage events (LIVE/DRAFT) |
| `pages/paper-admin-users/index.html` | Manage users (ADMIN/USER roles) |
| `pages/paper-admin-notify/index.html` | Admin push composer |
| `pages/paper-merge-events/index.html` | Merge duplicate events (survivor picker) |
| `pages/paper-loading/index.html` | Skeleton loading placeholder |
| `pages/paper-error/index.html` | "No connection" offline state |

---

## 2. Design decisions — themes & exact tokens

Three themes. **All tokens are inline `<style>` per file** — no shared stylesheet. Canonical source `web/src/assets/styles.css [data-theme="sketch"]` is referenced but not present in this repo.

### Theme MONO — marketing kit (`components/*`, `pages/landing`)
Flat monochrome, **system font stack** (`-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`), no custom fonts, no SVG filter, no grid.
- `--bg:#f1f1f1` · `--fg:#111` · `--muted:#8a8a8a` (footer overrides `#666`) · `--line:#111` · `--surface:#fff` · `--border:#c9c9c9` (buttons-cards uses `#d9d9d9`) · `--r:8px` (posts uses `6px`) · `--maxw:1080px` (cta/pricing `900px`, social-proof `1000px`)
- Page `body background:#fff`. Borders `1.5px solid`. Radii in use: `2,4,6,8,10,12px,50%`.
- Only shadow: `box-shadow:0 1px 2px rgba(0,0,0,.06)`

### Theme SKETCH — hand-drawn mobile app (`pages/app-*`)
Google Fonts: `family=Gochi+Hand&family=Patrick+Hand&family=Shadows+Into+Light` (all weight 400).
```css
:root{
  --ink:#1a1a2e;
  --paper:#f7f7f3;
  --card:#fffef9;
  --muted:color-mix(in srgb, var(--ink) 52%, transparent);
  --grid:22px;                                              /* app-home only */
  --grid-line:color-mix(in srgb, var(--ink) 9%, transparent);       /* app-home only */
  --grid-line-minor:color-mix(in srgb, var(--ink) 6%, transparent); /* app-home only */
  --shadow:2px 2px 0 color-mix(in srgb, var(--ink) 18%, transparent);
  --shadow-lg:4px 4px 0 color-mix(in srgb, var(--ink) 22%, transparent);
}
/* app-gps-attendance also adds: --overlay:color-mix(in srgb,var(--ink) 45%,transparent); */
```
- **Fonts by role:** body = `"Patrick Hand","Bradley Hand",ui-rounded,system-ui,sans-serif`; headings/brand/buttons/tags/badges = `"Gochi Hand",cursive`; hints/sub-labels = `"Shadows Into Light",cursive`; status bar = `system-ui,sans-serif`.
- **Wobble filter** (applied via `.wob{filter:url(#wobble-soft)}`, disabled under `prefers-reduced-motion`):
```html
<filter id="wobble-soft">
  <feTurbulence type="fractalNoise" baseFrequency="0.013" numOctaves="3" result="noise"/>
  <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.5"/>
</filter>
```
- **Phone frame:** `width:384px; min-height:788px; border:2px solid var(--ink); border-radius:30px; box-shadow:var(--shadow-lg)`. Outer page `body{background:#e7e7ea; padding:24px}`.
- Radii in use: `30,16,15,14,12,11,10,2px,50%,999px`. Borders mostly `1.5px solid var(--ink)`; tags `1.3px`; tab bar top `2px`.

### Theme PAPER — "Paper Wireframe Kit" mobile app (`pages/paper-*`) — CANONICAL
Google Fonts: `family=Patrick+Hand&family=Inter:wght@500;600;700`.
```css
:root{
  --ink:#1B1B1B; --white:#FFFFFF;
  --g1:#EEEEEE; --g2:#D8D8D8; --g3:#B4B4B4; --g4:#929292; --g5:#696969; --g6:#454545;
  --accent:#37D4AD;         /* Caribbean Green — the single crayon accent */
  --accent-light:#DAFCF3;
  --radius:12px;
}
```
Ramp note: only `paper-home` defines the **full** `g1–g6` + `--radius`; most files use the reduced set `g1,g2,g4,g5`; `paper-events-list`/`paper-my-events`/`paper-notifications` add `--g6`; `paper-error`/`paper-loading`/`paper-report` omit `--accent-light`. **Accent `#37D4AD` is identical across all 42.**
- **Fonts by role:** body/base = `"Patrick Hand",ui-rounded,system-ui,sans-serif`; nearly all UI text/labels = `"Inter",sans-serif` (weights 500/600/700 inline).
- **Wobble filter** (differs from sketch — softer):
```html
<filter id="wobble-soft">
  <feTurbulence type="fractalNoise" baseFrequency=".012" numOctaves="3" result="noise"/>
  <feDisplacementMap in="SourceGraphic" in2="noise" scale="2"/>
</filter>
```
- **Phone frame:** `width:384px; min-height:788px; border:3px solid var(--ink); border-radius:42px`. Outer page `body{background:#d6d6d6; padding:24px}`.
- **Shadows (offset flat, hard):** `2px 2px 0 var(--ink)` (dominant) · `3px 3px 0 var(--g2)` · `5px 5px 0 var(--ink)` · `3px 3px 0 var(--accent)` · focus ring `0 0 0 3px var(--accent)`.
- Radii in use: `50%,999px,42,16,15,14,12,11,10,2px`. Borders `2px`/`3px solid var(--ink)` dominant; dashed variants for drop zones. Map grid = 40px `var(--g2)` lines.

### Quick cross-theme reference
| | MONO | SKETCH | PAPER |
|---|---|---|---|
| Ink/text | `#111` | `#1a1a2e` | `#1B1B1B` |
| Surface | `#f1f1f1`/`#fff` | `--paper #f7f7f3` / `--card #fffef9` | `--white #FFFFFF` / `--g1 #EEEEEE` |
| Outer bg | `#fff` | `#e7e7ea` | `#d6d6d6` |
| Accent | none | none (pure ink) | `#37D4AD` / light `#DAFCF3` |
| Fonts | system | Gochi + Patrick + Shadows Into Light | Patrick + Inter 500/600/700 |
| Wobble | none | `baseFreq 0.013 · scale 2.5` | `baseFreq .012 · scale 2` |
| Phone | n/a (desktop) | `2px` ink, radius `30px`, 384×788 | `3px` ink, radius `42px`, 384×788 |
| Shadows | `0 1px 2px rgba(0,0,0,.06)` | `2/2/0` & `4/4/0` color-mix ink | `2/2/0 ink`, `3/3/0 g2` |

---

## 3. Product logic (verbatim on-screen strings)

**RSVP / attendance states:** `RSVP` (open, spots) · `Going ✓` (joined; also a pill) · `12 going` / `8 going` count pills · `Full · waitlist 2` · `Join waitlist` / `Waitlist` · `Waitlist · 2` (my-events) · event-detail CTA `RSVP — first event free` sub `Then £5 per event · cancel up to 24h before`, attendees `8 going · 12 spots` · confirm `You're going!` / `First event free — see you there.` · my-events tabs `Upcoming` / `Past`.

**Membership** (identical in `app-membership` & `paper-membership`; lede `Your first event is free. Choose how you pay after that.`):
| Tier | Price (verbatim) | Flag | Includes | Button |
|---|---|---|---|---|
| `Pay as you go` | `£5 / event · first event free` | `Current` | Join any standard event · No commitment | `You're on this plan` |
| `Monthly` | `£19 / month · unlimited standard events` | `Popular` | Unlimited standard meetups · Cancel anytime | `Upgrade` |
| `Diamond 💎` | `coming soon · includes premium events` | — | Everything in Monthly · Access to premium events | `Coming soon` |

Disclaimer: `Dummy layout — no real charges yet.`

**GPS / check-in:** venue hidden until day-of — `Willen Lake (revealed 24h before)` / `Exact venue reveals 24h before the event`. Attendance modal: `You're here?` → `Coffee & Code is happening now. Confirm your attendance.` → primary `Confirm with location`, fallback `— or enter the host's code —` (cells `4 7 _ _`). Result: `You're marked present` / `Confirmed by location at Coffee & Code Meetup · 4:04 PM` / chip `✓ Attendance counted`. Waitlist claim: `🎉 A spot opened up!` / `Claim within 4:32` / `Claim my spot` / `Pass to next person`. **(No numeric check-in radius is surfaced in copy.)**

**Chat:** delivery ticks `✓` (sent) / `✓✓` (read); inline reactions `👍 3`, `❤️ 2`; composer `Message…`; empty `No messages yet` / `Be the first to say hi 👋`; reaction picker `👍 ❤️ 😂 🎉 🙌 ＋`; report (anonymous) reasons `Inappropriate behaviour` / `Spam or scam` / `Fake profile` / `Something else` + `Block this person`.

**Admin:** dashboard KPIs `1,240 Users` · `48 Live events` · `312 Going this week` · `£1.5k Revenue (mo)`; quick actions `＋ New event` / `Send push`. Manage events status `LIVE` / `DRAFT`. Merge events: `KEEP (SURVIVOR)` vs `MERGE INTO IT` → `→ 11 going after merge (1 duplicate removed). Attendees … notified & can cancel with no penalty.`. Users roles `ADMIN` / `USER` (phone-only shows `Phone user` / `+44 7•••• 123`). Send push audience `All users` / `Event attendees`, deep link `Opens (deep link) /events`, `Send to 1,240 people`.

**Notifications** (5 types, grouped by event, `Mark all read`): `A spot opened up — claim it before it's gone` · `3 new people are going` · `Starts in 1 hour — see you there` · `Sarah commented in the chat` · `Welcome to Marhaba — find your first meetup`.

**Onboarding/auth:** sign-in `Find your people. Plan the meetup.` → `Email me a code` / `Continue with Google` / `Prefer phone?`. Verify: `We sent a 4-digit code to you@example.com`, `Resend code (0:24)`. Complete profile `STEP 1 OF 2` (name/age/city). Pick interests `STEP 2 OF 2` — `Pick up to 5 … (3 selected)`, chips `Coffee, Hiking, Coding, Dog walks, Bouldering, Football, Food, Board games, …`.

**Payments (all DUMMY):** checkout `Dummy checkout — no real payment is taken`, `Event fee £5.00` (struck) / `First event FREE` / `Total £0.00`, test card `4242 4242 4242 4242` exp `12/28` CVC `123`. Methods `VISA •••• 4242 · Expires 12/28 · Default`, `Apple Pay`. Credits: balance `2 free event credits`, history `Referral reward +1`, `Welcome credit +1`, `Used — Coffee & Code −1`. Invite: `marhaba.app/i/basit`, stats `3 invited · 2 joined · 2 credits earned`.

**Events:** create type chips `Dog walks / Coffee / Sport / +`, fields Heading/Type/Date & time/Capacity/Location/Description → `Publish event`. Cancelled: `⚠ This event was cancelled` / `… it's been returned — no strike on your record.`. Map pin sheet `Coffee & Code Meetup · Tue 14 Jul · 18:30 · 0.4 mi away · 8 going`. Search filters `This weekend / Nearby / Free`.

---

## 4. Copy rules

- **Brand:** `Marhaba` in-app (sketch sub-line `find your people` lowercase; paper sub-line `FIND YOUR PEOPLE` caps + letter-spaced). `TeamMarhaba` in kit/showcase titles.
- **Primary tagline:** `Find your people. Plan the meetup.`
- **Casing:** sentence case for headings/body/buttons. **ALL-CAPS reserved for section labels/status chips only:** `STEP 1 OF 2`, `FILTERS`, `RESULTS · 2`, `HISTORY`, `QUICK ACTIONS`, `RECENT`, `KEEP (SURVIVOR)`, `LIVE`, `DRAFT`, `ADMIN`, `USER`, `VISA`.
- **Separators:** middot `·` for dates/meta/taglines (`Sun 12 Jul · 10:00 · Willen Lake`); em dash `—` for appositive/CTA phrasing (`RSVP — first event free`, `Done — find my people`).
- **Currency:** `£` GBP; struck original price + `FREE`/`£0.00`; proper minus glyph `−1`; fullwidth plus `＋` for add actions.
- **Emoji:** category/celebration 🐕 🦴 ☀️ 👋 🎉 🎁 💎; chat reactions only `👍 ❤️ 😂 🎉 🙌`; warning glyph `⚠`. Ticks `✓`/`✓✓` are glyphs, not emoji.
- **Voice:** warm, friendly, reassuring on money/safety (`no strike on your record`, `Reports are anonymous`, `no real charges yet`).

---

## 5. Gaps & placeholders

**No authoritative product spec exists** — the prose "spec" docs (`GENESIS.md`, `REPLAY.md`, `SPRINTS.md`, `DEPENDENCY-DAG.md`, `blackboard.md`, `AGENT-CLAIM-PROTOCOL.md`, `TODO.md`) describe the backend/DevOps fleet build (Epic 1 Foundation, Epic 2 SPINE), **not** meetup features. The meetup product is **Epic 3 "FLESH" — not yet ticketed**. `contact-directory-MASTER-SPEC.md` is an **imported reference spec for a different product** (Contact Directory) — patterns only, explicitly not a build target. **So the wireframes are the de-facto spec.**

**Theme coverage:** `paper` (42) is the fullest, canonical set. `sketch` (11) is a **strict subset** — every sketch screen has a paper twin; paper adds 31 screens sketch never got. (Project intent is to make the sketch/doodle theme the default — that would require building the missing 31 sketch screens.) Mono (9 + landing) is a **separate web-marketing kit**.

**Features named/implied but NOT wireframed:**
1. First-login onboarding tutorial / product tour (coachmarks) — only `paper-empty-home` exists.
2. Public health / uptime status page.
3. Account self-service — forgot/reset password + email verification (`paper-verify` is OTP entry only).
4. Real payment flow — checkout is a stub; no add-card/3DS, invoices, or refunds.
5. Teams / tenancy — the **next build epic**, yet no teams/groups/org screen.
6. OS permission-priming screens (GPS + push) — only the in-context modal exists.
7. Host (non-admin organiser) event management — attendee list / manage-attendees / host-side check-in.
8. Dedicated notification-preferences screen (may live inside `paper-settings`, unverified).
9. WebView-shell / native-chrome / dedicated offline-shell states (generic `paper-error` doubles as offline).

**Placeholder / reference-only (not real product content):**
- Mono marketing kit (`components/*` + `landing`) — **lorem-ipsum** throughout; real marketing copy unwritten.
- `app-checkout` / `paper-checkout` — stamped "Dummy checkout — no real payment is taken."
- `contact-directory-MASTER-SPEC.md` — foreign reference product.
- `blackboard.md` — per-run scratch (deleted on replay).
- `gallery.html` / `showcase.html` / `showcase-paper.html` — local index/preview files (not screens, not exported).
- `proof-illustrated-style.html` — style spike, not a product screen.
- `google-services.json` (997 B) — minimal Firebase stub.

**Highest-value gaps to resolve next:** onboarding tour · teams/tenancy (next epic) · real payments · account self-service.
