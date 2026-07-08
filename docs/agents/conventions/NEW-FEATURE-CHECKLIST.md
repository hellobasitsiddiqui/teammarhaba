# New-Feature Integration Checklist

**Audience:** anyone (human or agent) scoping or building a **new user-facing feature/page** in TeamMarhaba (e.g. Events, Messaging, Groups). Read this at **feature-epic planning**, *before* writing tickets.

**What this is:** the *integration surface* — the cross-cutting subsystems every new feature must wire into. It is the flip side of [`COMMON-FEATURES.md`](../project/COMMON-FEATURES.md): that file tracks *what the base product already has*; this file lists *what a new feature must touch to fit in*.

**Provenance:** distilled from a multi-agent audit of the repo (2026-07-01 — 12 parallel readers → deduped from ~90 raw findings). Part of the agent OS — **kept on replay; update it when a subsystem is added or changed.**

---

## Bottom line

A new user-facing feature touches **~23 distinct cross-cutting subsystems (15 mandatory · 7 usually · 1 optional)** and realistically fans out to **~7–9 tickets — an epic, not a ticket.**

**~80% of the work is *integration tax* into machinery that already exists; ~20% is your feature's own logic.** The single web SPA is the source for all four surfaces (web / mobile-web / Android / iOS WebView), so one page must *simultaneously*: register in the hash router, pass the two first-run gates (onboarding → terms), render only through the XSS-safe `el()` kit, be styled only by theme tokens, go through the authenticated `apiFetch` client, be backed by a default-deny `/api/v1` controller with Bean-Validation DTOs + RFC-7807 errors + a Flyway migration + a regenerated `openapi.json`, and ship a `@tagged` Playwright spec proven on desktop **and** mobile-chromium.

> ⚠️ **Most-forgotten trap:** the deep-link route is a **triple-maintained allow-list** kept in lock-step across `router.js`, `push-deeplink.js` `KNOWN_ROUTES`, and backend `PushRoutes.KNOWN`. Miss one and the push tap silently dies.

---

## The checklist (mandatory-first)

| # | Subsystem | Mandatory? | What a new feature must do | Key file(s) | Ticket ref |
|---|-----------|:--:|----------------------------|-------------|-----------|
| 1 | Hash router + view lifecycle | **Mandatory** | Add `#/events` const; add to `currentRoute()` whitelist + `PROTECTED`; toggle panel in `render()`; `enterEvents()` mount + `eventsActive` reset in `guard()`; import in router.js. **No unbounded `await` in guard** (TM-307) | `web/src/assets/router.js` | TM-109, TM-297 |
| 2 | View panel + `[hidden]` invariant | **Mandatory** | Add `<section id="events-view" hidden>` in `<main class="app">`; id must match `getElementById`; never remove `[hidden]{display:none!important}` | `web/src/index.html`, `styles.css` | TM-141 |
| 3 | index.html script registration | **Mandatory** | Register the module `<script type="module">` in correct order; env-guard native-only code to a no-op in the browser | `web/src/index.html` | TM-133, TM-278 |
| 4 | XSS-safe UX kit (`el()`) | **Mandatory** | Build ALL DOM via `el()`/`clear()` (textContent only, **no innerHTML**); outcomes via `toast()`; destructive actions via `confirmDialog()`, never native `confirm()` | `web/src/assets/ui.js` | TM-133 |
| 5 | Form / field / a11y conventions | **Mandatory** | `.tm-form-field` + label + `.tm-input` + hint + `role=alert` error; `aria-describedby`; `<form novalidate>`; **never name the button var `save`/`submit`** (TM-199 reload trap); `tm-btn-primary`, "Saving…" | `profile.js`, `onboarding.js`, `styles.css` | TM-167, TM-199 |
| 6 | Client-side validation | **Mandatory** | Declarative `FIELDS[]` + `validateField/validateAll/clearAllFieldErrors`; rules mirror the backend DTO; live-clear on input; `validateAll()` before any network call | `profile.js`, `onboarding.js` | TM-162, TM-167 |
| 7 | Auth client (`apiFetch`) + `ApiError` | **Mandatory** | All backend calls through `apiFetch()` (Bearer + 401 refresh/retry/redirect); typed helper throwing `ApiError`; paint `fieldErrors` via `setFieldError()`. **Never hand-roll fetch** | `web/src/assets/api.js` | TM-108, TM-104, TM-79 |
| 8 | Auth guard + PROTECTED + intended-route | **Mandatory** | Add route to `PROTECTED` Set; guard stashes `tm.intendedRoute` and bounces to `#/login` (same key api.js writes on 401). Client guard is UX-only | `router.js`, `api.js` | TM-109, TM-79 |
| 9 | First-run gate chain (onboarding → terms) | **Mandatory** | Do NOT add a bypass; inherit the gates by joining PROTECTED; hide the nav link while `gated`; don't whitelist through the terms gate (Help is the only exception) | `router.js`, `terms-gate.js`, `onboarding.js` | TM-250, TM-170 |
| 10 | CSS Paper-token contract | **Mandatory** | Style only via `var(--token)` and reuse `.tm-*` component classes; **never hard-code hex/px/rgba/font** — it won't re-tint with the per-user accent, won't flip clean⇄wavy, and won't adapt to dark. Paper is the single theme (TM-529) | `web/src/assets/styles.css` | TM-510, TM-211, TM-529 |
| 11 | Paper appearance (accent + sketchy) | **Mandatory** | Don't read/apply appearance yourself; inherit it. The per-user accent lives in `--accent` and the wavy/sketchy skin under `[data-sketchy="on"]` — both applied for you by `appearance.js` (boot) + `appearance-sync.js` (server). If you must, use `appearance-core.js` helpers; never invent a theme/`data-theme` axis | `appearance-core.js`, `appearance.js` | TM-529 |
| 12 | Backend: API versioning + default-deny + role | **Mandatory** | Controller in `…backend.api` (auto `/api/v1`, no hardcoded prefix); default-deny = auth'd automatically; identity from `@AuthenticationPrincipal VerifiedUser`; admin actions `@PreAuthorize("hasRole('ADMIN')")` | `ApiV1Config.java`, `SecurityConfig.java`, `VerifiedUser.java` | TM-79, TM-111, TM-283 |
| 13 | DTO + Bean Validation + RFC-7807 + pagination | **Mandatory** | Immutable request records with `@NotBlank/@Size/@Min…` + `@Valid`; response via `from(entity)` (never serialize the entity); throw shared `ResourceNotFoundException`/`BadRequestException`; list via `PageRequests.of(...)` → `PageResponse.from(...)` | `UpdateMeRequest.java`, `Problems.java`, `PageRequests.java` | TM-72, TM-115, TM-162 |
| 14 | JPA + Flyway + OpenAPI-drift + JSON-only | **Mandatory** | `@Entity` matching a new `V__…sql` (ddl `validate`); enums as VARCHAR, `@Version`, FK `ON DELETE CASCADE`, UNIQUE where "one per user"; **regen + commit `openapi.json`** or CI fails | `db/migration/V*.sql`, `OpenApiDriftTest.java` | TM-283, TM-71 |
| 15 | Playwright e2e + harness + dispatch | **Mandatory** | `tests/<feature>.spec.mjs` tagged `@<feature>`; copy the `tm.tour.*` suppression `beforeEach` byte-for-byte; reuse `fixtures.mjs`/`global-setup.mjs`; assert UI **and** Postgres persistence; add the tag to `test-suite.yml`; keep `screenshot:'on'`; prove on mobile-chromium | `web/e2e/tests/*.spec.mjs`, `test-suite.yml`, `playwright.config.mjs` | TM-134, TM-167, TM-340 |
| 16 | Nav link + per-link visibility | Usually | `<a id="nav-events" href="#/events">` in `#nav-items`; set `.hidden` in `render()` (`!signedIn || gated`); hamburger auto-closes via nav-toggle.js. (A deliberately unobtrusive page can skip nav and be linked from another view) | `index.html`, `router.js`, `nav-toggle.js` | TM-109, TM-229, TM-297 |
| 17 | Loading / error / empty states | Usually | Hold `{loading,loaded,error,data}`; `.tm-error.tm-empty` + Retry on failure; distinct "nothing yet" vs "nothing matches filters" copy + a doodle motif | `profile.js`, `admin.js`, `doodles.js` | TM-167, TM-214 |
| 18 | Product tour / coachmark | Usually | Add `PAGE_HIGHLIGHTS["#/events"]` (`{target,title,body}`, intro card first) + register `PAGE_TOURS["#/events"]`; target stable ids; honour `suppressAutoTours`. Single source shared with the Help guide | `tour-highlights.js`, `tours.js` | TM-135, TM-178 |
| 19 | Help page + annotated guide | Usually | Add a prose `section()` in help.js `build()` + a `SCREENS` entry in help-guide.js (callouts via `fromHighlight:` so wording can't drift) | `help.js`, `help-guide.js` | TM-255, TM-178 |
| 20 | WebView-env + native bridge gating | Usually | Consult `isWebViewEnv()` for browser-only affordances; reach plugins via `window.Capacitor.Plugins.*` (**never** `import @capacitor/*`); redirect-not-popup; bracket any camera/picker with `begin/endTrustedExcursion()` (TM-334/337 re-lock trap) | `auth-env.js`, `native-camera.js`, `biometric-lock.js` | TM-230, TM-275, TM-334 |
| 21 | Responsive / safe-area shell | Usually* | Work at ~393px: nav inside hamburger, no horizontal PAGE scroll (wide tables scroll in their wrapper), ≥44px taps, fold `env(safe-area-inset-*)` into any sticky/fixed element. **\*Effectively mandatory** for anything mobile-facing (all four surfaces are phone-sized) | `styles.css`, `nav-toggle.js`, `responsive-mobile.spec.mjs` | TM-229, TM-295 |
| 22 | Deep-link route allow-list (triple) + push send | Usually | If push-targetable: add `#/events` to `router.js` **and** `push-deeplink.js KNOWN_ROUTES` **and** backend `PushRoutes.KNOWN` (kept in lock-step); send via `PushNotificationService.sendToUser(...)` best-effort in try/catch. Also append `AuditAction` + audit any state change | `push-deeplink.js`, `PushRoutes.java`, `PushNotificationService.java`, `AuditAction.java` | TM-285, TM-284, TM-113 |
| 23 | Doodle decoration (static markup only) | Optional | Only if the page is hand-written static markup: mount `doodle(name)` with `.tm-doodle-*` classes; reuse `#wobble-soft`; never a new filter. Pages built via `el()` inherit theme automatically | `doodles.js`, `doodle-decor.js` | TM-214, TM-215 |
| — | Runtime config `TEAMMARHABA_CONFIG` + deploy inject | Optional | Only if the feature needs a prod-tunable value / kill-switch: add a frozen field in config.js (dev-safe default) + a `sed` inject step in **both** deploy.yml and android-release.yml. No general feature-flag framework exists | `config.js`, `deploy.yml` | TM-104, TM-142 |

---

## Worked example — "Events (bookable)"

A signed-in user browses events, books one (capacity-limited, one booking per user), sees their bookings; admins create/cancel events.

**Backend (items 12–14, 22):** `EventController` + `BookingController` in `…backend.api`; `CreateEventRequest`/`CreateBookingRequest` records with validation; `Event` + `Booking` entities with `V__create_events.sql` / `V__create_bookings.sql` (UNIQUE `(user_id,event_id)` → double-book maps to 409 for free); "Event full"/"already booked" → one `@ExceptionHandler` via `Problems.unprocessable` (422); admin create/cancel `@PreAuthorize`; append `EVENT_*`/`BOOKING_*` to `AuditAction`; **regen `openapi.json`**.

**Web (items 1–11, 16–19, 21):** `#/events` route registered + PROTECTED + behind the gates; `events-view` section; built with `el()`; loading/error/empty states; booking confirm via `confirmDialog({danger:true})` + success `toast()`; admin create form using the field/validation conventions; `getEvents/bookEvent/cancelBooking` on `apiFetch`; nav link; page tour; Help prose + `SCREENS` mock; responsive.

**Push / e2e (items 15, 22):** `#/events` in all three allow-lists; `events.spec.mjs` tagged `@events` (book happy path + "event full" path) asserting the `bookings` row persists; splice into `golden-path.spec.mjs`; add `@events` to `test-suite.yml`; prove on mobile-chromium.

### Ticket shape (~7–9 tickets — this is `jira-epic-breakdown`, not one ticket)

1. **Backend: Events entity + CRUD API** (migration, entity, controller, DTOs, RFC-7807, openapi regen) — *foundation, blocks the rest*
2. **Backend: Bookings + capacity/dedup rule** (unique constraint, 409/422, audit actions) — *blocked by #1*
3. **Web: Events list + detail view** (router, view module, empty/error states, apiFetch helpers, nav link) — *blocked by #1*
4. **Web: Booking flow** (confirm dialog, capacity handling, "my bookings") — *blocked by #2, #3*
5. **Web: Admin create/cancel event** (form conventions, validation mirror) — *blocked by #1, #3*
6. **Push deep-link + notifications** (triple allow-list, `sendToUser` on booking) — *blocked by #2*
7. **e2e: `@events` spec + golden-path splice + test-suite registration** — *blocked by #3–#5*
8. *(usually)* **Product tour + Help coverage for Events** — *blocked by #3*
9. *(if needed)* **HITL/config** ticket only if a prod flag or new secret is required

**Waves:** #1 → then #2/#3 in parallel → then #4/#5/#6 → then #7/#8.

---

## How to use this

- At **epic breakdown**, map the feature onto the table above; each cluster (backend API+migration · web view+router · forms/validation · push/deep-link · e2e · tour+Help) is usually its own ticket, with the backend foundation blocking the web tickets.
- A feature's **Definition of Done = all mandatory items + the two testing gates** (automated e2e with screenshots **and** a human smoke) per the [sprint-closure rule](AGENTIC-LESSONS.md) — merged ≠ shipped ≠ verified.
- **Keep this current:** when a subsystem is added or changed (a new gate, a 4th allow-list, a theme), update the table. This file is part of the agent OS and is kept on replay.
