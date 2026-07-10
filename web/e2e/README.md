# Browser e2e (Playwright) — TM-134

The first browser end-to-end harness. It drives a **real browser** through the critical
login + admin flow against the full stack, with Firebase Auth replaced by the local
**Firebase Auth emulator** so the suite is hermetic and needs no secrets.

> **Runs on `main` only.** CI executes this via [`.github/workflows/e2e.yml`](../../.github/workflows/e2e.yml)
> on push to `main` and manual dispatch — **never on the PR gate** (it's slow; the fast gate
> stays in `ci.yml`). Adding a new walkthrough is a new spec file under `tests/`, not new infra.

## What the walkthrough proves

`tests/admin-walkthrough.spec.mjs`: anonymous → **sign in as an ADMIN** → the admin nav appears
(ROLE_ADMIN only) → open the **users console** → **disable a user** → the UI reflects it (success
toast + status badge flips to *Disabled*) → the change **persists in Postgres** (`users.enabled = false`)
→ **sign out**.

`tests/theme-visual.spec.mjs` (TM-216 origin; rewritten for TM-529): guards the **Paper appearance**
so a look can't silently break a page. Proves the app **boots to Paper** (the single theme; no
`data-theme` family switch, `<html data-sketchy>` defaults to `on`), walks the **key pages** —
**login, home, profile, admin** — asserting each page's **primary control** is visible and **not
covered or clipped** (a cheap "no layout break" invariant — no pixel snapshots, so no font/SVG-filter
flake), and then exercises the **two per-user controls** in profile settings — the **curated accent
swatches** and the **wavy/sketchy toggle** — proving each **applies live and PERSISTS SERVER-SIDE**: a
reload re-reads the choice from `GET /api/v1/me` (not localStorage) and re-applies it.

### Per-user appearance (accent + wavy/sketchy)

There is no theme-family override any more. The look is personalised per user from profile settings and
persisted server-side (`PATCH /api/v1/me` → `users.theme_accent` / `users.theme_sketchy`). At boot,
`appearance.js` paints a fast, no-flash guess from a `tm-appearance` **localStorage hint**, then
`appearance-sync.js` reconciles it with the server on auth-resolve — so the chosen accent + toggle apply
on **every** page and follow the user **across devices**. The accent is a **fixed curated palette** (six
`--accent-paper-*` swatches, kept in step between CSS and `appearance-core.js`), never a free colour
picker, so no non-Paper look is selectable.

## How it fits together

- **Auth = Firebase Auth emulator.** The web app connects to it via a guarded `connectAuthEmulator`
  (active only when `window.TEAMMARHABA_CONFIG.authEmulatorHost` is set — null in dev/prod, so
  production auth is untouched). The backend trusts emulator tokens via `FIREBASE_AUTH_EMULATOR_HOST`
  (no real credentials). `global-setup.mjs` seeds an admin (with the `role=ADMIN` claim) + a target
  user and provisions them in the backend.
- **Web = `serve.mjs`**, a tiny static server that serves `web/src` and injects an e2e `config.js`
  (backend URL + emulator host) so the committed `config.js` stays prod-clean. Playwright starts it.
- **Backend + Postgres + emulator** are started before Playwright (by the workflow, or by you locally).

## Run locally

Prereqs: Node 20+, JDK 21, Docker (for Postgres), and a built backend jar.

```bash
# 1. Postgres (any local instance works; defaults assume these creds)
docker run --rm -d --name tm-e2e-pg -p 5432:5432 \
  -e POSTGRES_DB=teammarhaba -e POSTGRES_USER=app -e POSTGRES_PASSWORD=devpassword postgres:16-alpine

# 2. Firebase Auth emulator (from this dir)
cd web/e2e && npm install
npm run emulator        # serves the Auth emulator on 127.0.0.1:9099

# 3. Backend, pointed at the emulator + Postgres (new terminal, from repo root)
cd backend && ./mvnw -DskipTests package
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 FIREBASE_PROJECT_ID=teammarhaba \
  SPRING_PROFILES_ACTIVE=dev \
  SPRING_DATASOURCE_URL=jdbc:postgresql://127.0.0.1:5432/teammarhaba \
  SPRING_DATASOURCE_USERNAME=app SPRING_DATASOURCE_PASSWORD=devpassword \
  java -jar target/*.jar

# 4. Run the suite (new terminal, from web/e2e) — Playwright starts the web server itself
cd web/e2e
npx playwright install chromium
npm test                # or: npm run test:headed
npm run report          # open the HTML report
```

Overrides (all optional): `E2E_API_BASE_URL`, `E2E_WEB_BASE_URL`, `E2E_AUTH_EMULATOR_HOST`,
`DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` — see `fixtures.mjs`.

## Adding a walkthrough

Drop a new `tests/<name>.spec.mjs`. Reuse the seeded accounts + DB seam in `fixtures.mjs`; if you
need more accounts, seed them in `global-setup.mjs`. No new workflow or infra required.

## Seeding a test user's chat (TM-587)

The Event Chat foundation screens (list TM-438, thread TM-448, unread Chat-tab badge TM-439) need
SEEDED conversations + messages to render anything. Now that posting (TM-447), the admin-broadcast
bridge (TM-588) and the event-chat lifecycle (TM-446) all exist, a **profile-gated, non-prod-only seed
endpoint** populates a signed-in caller's chat in one call:

```
POST /api/v1/test/chat/seed        # identity = the caller's Bearer token; seeds THAT account's chat
→ { alreadySeeded, eventThreads: 2, adminThreads: 1, unreadTotal: 10 }
```

It creates two event group threads (`Sunday Morning Dog Walk` fully unread, `Riverside 5k Run Club`
read) + an admin `TeamMarhaba` channel (unread), each with real messages, via the same lifecycle /
factory paths production uses — so the read API renders production data, only its rows are seeded. It is
**idempotent** (a re-seed is a no-op), so it's safe on every run / CI retry.

**It cannot exist in prod.** The endpoint + service are gated by `app.test-seed.enabled` (base default
`false`; only the `dev` + `test` profiles set it `true`) **and** `@Profile("!prod")`, and are `@Hidden`
from the OpenAPI spec. `ChatSeedDisabledIntegrationTest` proves the beans vanish when the flag is off.

The browser-e2e backend runs on the `dev` profile (see `.github/workflows/e2e.yml`), so the endpoint is
available there. `chat-seed.mjs` wraps it (mint an emulator token → POST); `tests/chat-foundation.spec.mjs`
uses it to render + assert the populated list / an open thread / the unread badge against a **live
backend** (no route mocks) at the Pixel 5 viewport, with named screenshots for the TM-564 evidence.

## Visual-evidence capture — chat foundation (TM-564, live TM-587)

`capture-chat-foundation.mjs` is a **standalone** screenshot harness (not part of the Playwright suite)
for the Event Chat foundation screens at a phone viewport (Pixel 5) on the default Paper look. It runs
in one of two modes:

```bash
cd web/e2e
npm run capture:chat                    # MOCK mode (default) — no stack needed
CAPTURE_LIVE=1 npm run capture:chat     # LIVE mode — needs the running stack (below)
```

- **MOCK mode (default)** needs **no backend, emulator or Postgres**: it injects fixtures matching the
  TM-436 API contract at the network seam and drives the real `chat.js` DOM + Paper CSS — every pixel is
  production UI, only the JSON payloads are fixtures. It also captures the empty / loading / error edge
  states (which need no live data).
- **LIVE mode (`CAPTURE_LIVE=1`, TM-587)** closes the route-mock gap TM-564 flagged: with the same stack
  the Playwright suite uses (backend on `dev` + Auth emulator + Postgres — see *Run locally* above), it
  seeds the `CHAT_SEED` account via the seed endpoint, signs in through the real login UI, and captures
  the populated list / thread / badge from the **live backend** — no mocks.

Run under Node 20 (the version CI pins).

## Known follow-up

The ticket's "assert it appears in the audit log" step is **deferred**: admin enable/disable/role
actions aren't yet recorded to the audit log (`UserAdminService` doesn't call `AuditService`), and
there's no audit **read** endpoint. The walkthrough asserts persisted state instead; the same DB
seam will assert the `audit_events` row once that wiring + endpoint land (raised as a follow-up).
