# Common Features — generic base-product coverage tracker

The single source for **"what generic, product-agnostic features does the base product have?"** —
so we never re-discover a gap (the way Playwright and the seed-admin were missed). Seeded from the
Contact Directory reference spec's common-baseline (`contact-directory-MASTER-SPEC.md` §2, §305) and
our actual state.

**Scope:** generic/reusable features only (the SPINE you'd reuse in *any* app). Product-specific
features (contacts CRUD, tags, CSV, …) live in Epic 3 (FLESH), not here.

**Legend:** ✅ built · 🔜 planned (ticket exists) · ⬜ deferred (deliberate, reason noted) · ❔ verify.
**Keep this current:** update the row when a ticket lands; add a row when a new generic feature is
identified. This file is part of the agent OS (kept on replay).

## Auth & accounts
| Feature | Status | Where / ticket |
|---|:--:|---|
| Registration / login / social / logout / session / refresh / lockout | ✅ | Firebase Auth (ADR-0004) — not hand-rolled |
| Profile (`GET`/`PATCH /api/v1/me`) | ✅ | TM-107 / TM-112 |
| Password reset + email verification (UI wiring) | ⬜ | Firebase provides; UI deferred → Hardening epic |
| 2FA / MFA (TOTP) | ⬜ | deferred |

## Authorization & admin
| Feature | Status | Where / ticket |
|---|:--:|---|
| RBAC (USER/ADMIN) — Firebase claims → Spring authorities | ✅ | TM-110 |
| **Bootstrap the first ADMIN** (env-driven seed) | ✅ | TM-110 — *was a gap; without it the admin surface is unreachable* |
| Admin user-management endpoints (list/enable/disable/set-role) | ✅ | TM-111 |
| Admin users console (web UI) | ✅ | TM-133 |
| 404-not-403 on cross-user access; admin self-protection | ✅ | TM-111 |
| Fine-grained perms; multi-tenancy / teams | ⬜ | Epic 3 candidate |

## API design
| Feature | Status | Where / ticket |
|---|:--:|---|
| `/api/v1` versioning; RFC-7807 error model; request validation | ✅ | Epic 1 |
| Pagination / filter / sort + reusable `Page<T>` | ✅ | TM-115 (applied to admin users list) |
| Optimistic concurrency (`@Version` → 409/412) | ✅ | TM-114 |
| OpenAPI / Swagger | ✅ (non-prod) | enabled in dev; **off in prod by decision** (TM-76) |
| Global rate limiting | ⬜ | deferred → Hardening epic |

## Data & persistence
| Feature | Status | Where / ticket |
|---|:--:|---|
| Spring Data JPA + Hibernate; Flyway-owned schema | ✅ | Epic 1 / TM-71 |
| Soft-delete + restore | ✅ | TM-114 (applied to `users`) |
| Created/updated timestamps | ✅ | base entity |
| Seed / reference data | ✅ | folded into seed-admin (TM-110) |
| Backups / restore (DR) | ⬜ | deferred |

## Observability
| Feature | Status | Where / ticket |
|---|:--:|---|
| Actuator health (public) + metrics (authed) | ✅ | TM-74 |
| Append-only audit log | ✅ | TM-113 |
| Structured logging | ✅ (partial) | TM-73 |
| Public status / uptime page (CD-051) | ⬜ | deferred → Hardening epic |
| Distributed tracing; error monitoring | ⬜ | deferred |

## Security hardening
| Feature | Status | Where / ticket |
|---|:--:|---|
| HSTS + frame-options | ✅ | Epic 1 |
| Content-Security-Policy (CSP) | ⬜ | deferred → Hardening epic |
| Dependabot + dependency-review + CodeQL + gitleaks | ✅ | Epic 1 CI |
| Input validation / output encoding (XSS-safe) | ✅ | backend ✅; web XSS-safety enforced in TM-133 |
| Cloud SQL private IP / VPC | ⬜ | TM-95 (prod-readiness) |

## Testing & drift guards
Drift guards = CI checks that fail when reality drifts from a committed contract/spec.
| Guard | Status | Where / ticket |
|---|:--:|---|
| Unit + integration tests; JaCoCo coverage gate (LINE 0.85 / BRANCH 0.70) | ✅ | Epic 1 / TM-54 |
| DB schema drift — `ddl-auto: validate` (boot fails if `@Entity` ≠ Flyway schema) | ✅ | TM-71 / app config |
| Format drift — Spotless `spotless:check` | ✅ | Epic 1 CI |
| Browser e2e (Playwright) — UI-regression guard | ✅ | TM-134 (runs on `main`, off the PR gate) |
| `.env.example` contract — fail-loud secrets/env validator | ✅ | TM-64 |
| **OpenAPI spec drift check** (committed `openapi.json` vs generated; CI fails on drift) | ✅ | TM-135 |
| CD "new revision is actually serving" verify | ✅ | TM-60 (post TM-131) |
| Docs-only auto-merge / no-untracked-PR guards | ✅ | automerge-docs / claim protocol |

## CI/CD & build
| Feature | Status | Where / ticket |
|---|:--:|---|
| Build wrapper; GH Actions on push/PR | ✅ | Epic 1 |
| Containerization (image → Artifact Registry) | ✅ | Epic 1 / TM-60 |
| Continuous deploy (Cloud Run + Firebase Hosting) | ✅ | TM-60 / TM-61 |
| Release-on-tag automation; status badges | ❔ | verify |

## Config & ops
| Feature | Status | Where / ticket |
|---|:--:|---|
| 12-factor env config; dev/test/prod profiles | ✅ | Epic 1 |
| Feature flags | ⬜ | deferred (YAGNI until needed) |

## Frontend / UX (generic primitives)
| Feature | Status | Where / ticket |
|---|:--:|---|
| Reusable UX kit: toasts, styled confirm dialog, copy-to-clipboard, relative-time, loading/empty/error | ✅ | built in TM-133 (first consumer) |
| Dark / light theme (persisted) | ✅ | TM-133 |
| Responsive layout; a11y; i18n | ⬜ | partial/deferred (matters for the mobile surfaces, Epic 3+) |

## Compliance & privacy
| Feature | Status | Where / ticket |
|---|:--:|---|
| GDPR data export / deletion; consent & retention | ⬜ | deferred |

---

## Deferred epics (mapped to the anatomy arc)

Generic, important, but not built — captured so they're not lost. They split across the next phases of the arc (SKELETON → SPINE ✅ → FLESH → **MUSCLE** → **SENSES**) plus some platform/UX leftovers. Loose prod-readiness tickets **TM-95/97/98/99** fold into MUSCLE. *(OpenAPI drift is already ticketed — TM-135.)*

### MUSCLE — Hardening & Prod-readiness
Strength: resilience, security, performance, scaling. **What's inside:**

| Area | Feature | Why / note | Priority |
|---|---|---|:--:|
| Resilience | Graceful degradation — timeouts / retries / circuit-breakers / fallbacks | a hung dependency currently hangs the request | ⭐ |
| Resilience | Graceful shutdown — drain in-flight requests on deploy | clean rollouts | high |
| Resilience | Idempotency keys on mutating endpoints | retry / double-submit safety | high |
| DR | Backups + **restore drill** | an untested backup = no backup | ⭐ |
| DR | DR runbook | recovery procedure | med |
| Security | Rate limiting | abuse protection beyond login lockout | high |
| Security | Request payload / size limits | cheap DoS guard | high |
| Security | CSP header | XSS hardening (already have HSTS + frame-options) | med |
| Security | Secrets rotation | DB password / keys on a schedule | med |
| Security | 2FA / MFA (TOTP) | account hardening (via Firebase) | med |
| Performance | Caching layer (response / data) | latency + DB load | med |
| Performance | Load / perf-test baseline | know the limits before they hit | med |
| Performance | Connection-pool tuning | DB throughput | low |
| Scaling | App-tier scale-out · read replicas · HA / failover | grow with load | low |
| Quality | Sonar quality gate | overlaps CodeQL/Spotless/JaCoCo | optional |
| Ops | Maintenance mode · cost / budget alerts | planned downtime, spend guard | low |
| Data | Audit-log retention policy | it grows unbounded | med |

### MUSCLE — E2E hardening (minimize manual testing)
Goal: push automated coverage so manual testing shrinks to a thin residue (real OAuth consent, real email deliverability, first-pass exploratory). Builds on the TM-134 Playwright harness (`web/e2e/`).

**Dependency DAG**
- Independent — **start now:** M1, M2, M3, M4, M6
- **M5 ← M4** — wire the deployed smoke into the canary after it exists
- **M7 ← TM-137** — needs the audit read endpoint + admin-action audit wiring
- Parallelism: **5 agents can start at once** (M1, M2, M3, M4, M6); then M5 after M4; M7 after TM-137.

**M1 — Social-login + password-reset/verify e2e (emulator)** · `testing` `e2e` `web`
Cover the social-login and password-reset/verify flows with Playwright against the Auth emulator, so those paths are automated (not manual).
- AC: a spec drives social sign-in via the emulator's IdP simulation (`signInWithIdp` / auto-confirmed popup) — exercises the OAuth wiring hermetically; a spec drives reset + verification by reading the code from the emulator's `oobCode` REST API (`/emulator/v1/projects/{p}/oobCodes`); reuses `web/e2e/` fixtures/global-setup — new specs only, no new infra.
- Agent: add `web/e2e/tests/social-login.spec.mjs` + `password-reset.spec.mjs`; use emulator REST for IdP sign-in and oobCodes; seed accounts in `global-setup.mjs`. **Out of scope:** real Google consent (can't automate).

**M2 — Visual-regression snapshots** · `testing` `e2e` `web`
Screenshot diffs on key pages/themes so visual regressions fail CI.
- AC: `toHaveScreenshot()` baselines for login, home, admin console; matrix of light/dark × mobile/desktop viewports (Playwright projects); rendering pinned for stability (containerized run, fonts, animations disabled); baseline-update process documented.
- Agent: add a visual project to `playwright.config.mjs` + `tests/visual.spec.mjs`; commit baselines generated in the CI container image; document `--update-snapshots`. Runs in `e2e.yml` (main-only).

**M3 — Accessibility checks** · `testing` `e2e` `web` `a11y`
Automated a11y assertions so violations are caught per page.
- AC: `@axe-core/playwright` asserts no serious/critical violations on login, home, admin console; findings reported as artifacts; thresholds documented.
- Agent: add `@axe-core/playwright` to `web/e2e/package.json`; `tests/a11y.spec.mjs` scans each route after load; fail on serious + critical.

**M4 — Post-deploy Playwright smoke (deployed env)** · `testing` `e2e` `ci`
A small Playwright smoke against the deployed URL so deploy/config drift (CORS, injected `apiBaseUrl`, public access, real ADC) is caught automatically.
- AC: a read-only smoke (login with a seeded test account → home loads → one read) against the deployed Firebase Hosting URL; uses a dedicated test account in the real Firebase project, creds from GitHub secrets (no prod-data mutation); runs as a job after `deploy.yml` (or a callable workflow); artifacts on failure.
- Agent: add `web/e2e/tests/deployed-smoke.spec.mjs` gated by `E2E_TARGET=deployed`, pointing at the real URL + real Firebase (no emulator); wire a post-deploy job; store test creds in secrets; keep minimal + non-mutating.
- **HITL:** needs a human to create the seeded test account + add the secret — split into a `human` ticket if not already covered.

**M5 — Wire the deployed smoke into nightly-canary** · `testing` `e2e` `ci` · *blocked by M4*
Run the deployed smoke on a schedule so drift is caught even without a deploy.
- AC: `nightly-canary.yml` invokes the M4 deployed smoke nightly; failure notifies per the existing canary convention.
- Agent: extend `.github/workflows/nightly-canary.yml` to call the deployed-smoke job/workflow; reuse the same secrets.

**M6 — Expand journey coverage (one spec per critical flow)** · `testing` `e2e` `web`
A Playwright spec per critical user journey so the core flows are regression-guarded.
- AC: specs for sign-up→home→sign-out, protected-route guard + USER→admin 403, admin set-role, and search/filter/sort/paginate in the console; mirrors the per-epic manual walkthroughs in `docs/qa/MANUAL-WALKTHROUGHS.md` — that doc updated to note which flows are now automated.
- Agent: add focused specs under `web/e2e/tests/`; cross-link to the manual walkthrough doc and trim the now-automated manual steps.

**M7 — Audit-panel + soft-delete + 409 e2e** · `testing` `e2e` `web` · *blocked by TM-137*
Cover the not-yet-wired behaviours once they ship.
- AC: after TM-137 lands the audit read endpoint + admin-action audit wiring, the walkthrough asserts the `audit_events` entry via the API/UI (replacing the interim DB assertion); soft-delete + restore covered once there's a UI action; optimistic-concurrency 409 covered via a two-request API-level test.
- Agent: extend the admin walkthrough to assert the audit row through the read endpoint; add a 409 concurrency test; add soft-delete/restore coverage when the UI affordance exists.

### SENSES — Observability
Alerting / SLOs + dashboards (metrics exist; alerts don't) · correlation / request IDs through logs · distributed tracing · error monitoring (Sentry-style) · log-retention policy.

### Platform / UX / compliance leftovers (a later platform epic or Epic 3 — *not* hardening)
Account self-service UI (password reset / email verification) · public status page · i18n · full a11y / responsive · onboarding / first-login tutorial · white-label / theming (re-skin) · email / notifications service · file / object storage · full-text search · background jobs / async queue · scheduled tasks · webhooks / outbound events · machine-to-machine auth · push notifications (FCM) · cookie-consent banner · admin impersonation · audit-log viewer/export UI · GDPR export/deletion + consent/retention · feature flags.

## → Epic 3 (FLESH, product-specific)
First real product feature + anything domain-specific (contacts CRUD/tags/CSV/favourites/photo/bulk).
**Tenancy / teams** is the leading Epic-3 candidate (generic-ish, fits the name).
