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
| RBAC (USER/ADMIN) — Firebase claims → Spring authorities | 🔜 | TM-110 |
| **Bootstrap the first ADMIN** (env-driven seed) | 🔜 | TM-110 — *was a gap; without it the admin surface is unreachable* |
| Admin user-management endpoints (list/enable/disable/set-role) | 🔜 | TM-111 |
| Admin users console (web UI) | 🔜 | TM-133 |
| 404-not-403 on cross-user access; admin self-protection | 🔜 | TM-111 |
| Fine-grained perms; multi-tenancy / teams | ⬜ | Epic 3 candidate |

## API design
| Feature | Status | Where / ticket |
|---|:--:|---|
| `/api/v1` versioning; RFC-7807 error model; request validation | ✅ | Epic 1 |
| Pagination / filter / sort + reusable `Page<T>` | 🔜 | TM-115 (applied to admin users list) |
| Optimistic concurrency (`@Version` → 409/412) | 🔜 | TM-114 |
| OpenAPI / Swagger | ✅ (non-prod) | enabled in dev; **off in prod by decision** (TM-76) |
| Global rate limiting | ⬜ | deferred → Hardening epic |

## Data & persistence
| Feature | Status | Where / ticket |
|---|:--:|---|
| Spring Data JPA + Hibernate; Flyway-owned schema | ✅ | Epic 1 / TM-71 |
| Soft-delete + restore | 🔜 | TM-114 (applied to `users`) |
| Created/updated timestamps | ✅ | base entity |
| Seed / reference data | 🔜 | folded into seed-admin (TM-110) |
| Backups / restore (DR) | ⬜ | deferred |

## Observability
| Feature | Status | Where / ticket |
|---|:--:|---|
| Actuator health (public) + metrics (authed) | ✅ | TM-74 |
| Append-only audit log | 🔜 | TM-113 |
| Structured logging | ✅ (partial) | TM-73 |
| Public status / uptime page (CD-051) | ⬜ | deferred → Hardening epic |
| Distributed tracing; error monitoring | ⬜ | deferred |

## Security hardening
| Feature | Status | Where / ticket |
|---|:--:|---|
| HSTS + frame-options | ✅ | Epic 1 |
| Content-Security-Policy (CSP) | ⬜ | deferred → Hardening epic |
| Dependabot + dependency-review + CodeQL + gitleaks | ✅ | Epic 1 CI |
| Input validation / output encoding (XSS-safe) | ✅ / 🔜 | backend ✅; web XSS-safety enforced in TM-133 |
| Cloud SQL private IP / VPC | ⬜ | TM-95 (prod-readiness) |

## Testing & drift guards
Drift guards = CI checks that fail when reality drifts from a committed contract/spec.
| Guard | Status | Where / ticket |
|---|:--:|---|
| Unit + integration tests; JaCoCo coverage gate (LINE 0.85 / BRANCH 0.70) | ✅ | Epic 1 / TM-54 |
| DB schema drift — `ddl-auto: validate` (boot fails if `@Entity` ≠ Flyway schema) | ✅ | TM-71 / app config |
| Format drift — Spotless `spotless:check` | ✅ | Epic 1 CI |
| Browser e2e (Playwright) — UI-regression guard | 🔜 | TM-134 (runs on `main`, off the PR gate) |
| `.env.example` contract — fail-loud secrets/env validator | ✅ | TM-64 |
| **OpenAPI spec drift check** (committed `openapi.json` vs generated; CI fails on drift) | 🔜 | TM-135 |
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
| Reusable UX kit: toasts, styled confirm dialog, copy-to-clipboard, relative-time, loading/empty/error | 🔜 | built in TM-133 (first consumer) |
| Dark / light theme (persisted) | 🔜 | TM-133 |
| Responsive layout; a11y; i18n | ⬜ | partial/deferred (matters for the mobile surfaces, Epic 3+) |

## Compliance & privacy
| Feature | Status | Where / ticket |
|---|:--:|---|
| GDPR data export / deletion; consent & retention | ⬜ | deferred |

---

## Deferred → future "Hardening / Prod-readiness" epic
Generic, important, but not built — captured so they're not lost. Grouped:

- **Security & abuse:** rate limiting · CSP · request **payload/size limits** (DoS) · **secrets rotation** (DB password / keys on a schedule)
- **Resilience & DR:** ⭐ **graceful degradation** (timeouts / retries / circuit-breakers / fallbacks for slow-or-down deps) · **graceful shutdown** (drain in-flight requests on deploy) · **backups + restore drill** (DR) · **idempotency keys** for mutating endpoints
- **Observability:** **alerting / SLOs + dashboards** (metrics exist; alerts don't) · **correlation/request IDs** through logs · distributed tracing · error monitoring (Sentry-style)
- **Performance:** **caching layer** (response/data) · **load/perf-test baseline** · connection-pool tuning
- **Quality:** **Sonar** (code-smell / tech-debt quality gate — overlaps CodeQL/Spotless/JaCoCo; *optional*)
- **Accounts / UX:** account self-service UI (password reset / email verification) · public status page · i18n · full a11y / responsive
- **Compliance:** GDPR export/deletion · consent & retention · **audit-log retention** policy (it grows unbounded)
- **Feature management:** feature flags

Would also adopt the loose prod-readiness tickets **TM-95, TM-97, TM-98, TM-99**. *(OpenAPI drift check is ticketed — TM-135.)* The ⭐ **graceful degradation** item is the one that actually bites in prod (a hung dependency currently hangs the request).

## → Epic 3 (FLESH, product-specific)
First real product feature + anything domain-specific (contacts CRUD/tags/CSV/favourites/photo/bulk).
**Tenancy / teams** is the leading Epic-3 candidate (generic-ish, fits the name).
