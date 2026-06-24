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

`tests/theme-visual.spec.mjs` (TM-216): guards the **theme system** so a theme can't silently break a
page. Proves the app **boots in the configured theme** (and that an unknown override is ignored), then
walks the **key pages** — **login, home, profile, admin** — under **both `clean` and `doodle`**,
asserting `<html data-theme>` is right and each page's **primary control** is visible and **not covered
or clipped** (a cheap "no layout break" invariant — no pixel snapshots, so no font/SVG-filter flake). It
flips themes with the **`?theme=` dev override** (see below), against the single served bundle.

### Theme dev override (`?theme=`)

`theme.js` honours a dev/test override at boot, layered over `window.TEAMMARHABA_CONFIG.theme`: a
`?theme=clean|doodle` **URL query param** (the app hash-routes, so the query sits *before* the hash —
`/?theme=clean#/login`) or a `tm-theme` **localStorage key** (query wins). Only `clean`/`doodle` are
honoured; any other value is ignored and the configured/default theme is used. It's a **client-side
visual toggle only** — no behaviour change, no data — so it's harmless in prod and lets you (and this
suite) exercise both themes without a redeploy. The override survives hash navigation, so the spec
loads it once via the initial URL then moves between views without reloading.

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

## Known follow-up

The ticket's "assert it appears in the audit log" step is **deferred**: admin enable/disable/role
actions aren't yet recorded to the audit log (`UserAdminService` doesn't call `AuditService`), and
there's no audit **read** endpoint. The walkthrough asserts persisted state instead; the same DB
seam will assert the `audit_events` row once that wiring + endpoint land (raised as a follow-up).
