# Epic 2 — SPINE (plan)

**Jira Epic:** `TM-102`. Living plan for the second epic. Epic 1 (Foundation/SKELETON) is done;
this turns the auth *seam* into a **real, usable login** with accounts, RBAC, audit, and reusable
data conventions. **Product-agnostic** — the first real product feature (FLESH) is Epic 3.

## Goal

Open the web app — locally via `make up` **or** the deployed Firebase URL — **sign up / log in
(incl. social)** → land on an authenticated page that calls the backend **as you** → your account
is persisted in Cloud SQL, role-gated, with the action audited.

## Key decision carried in

**Firebase Authentication is the IdP** (ADR-0004). So sign-up, login, social login, password
reset, email verification, refresh tokens, session management, and brute-force lockout are
**handled by Firebase** — we do **not** rebuild the contact-directory spec's hand-rolled
JWT/refresh/lockout stack. We build the *client wiring*, *authorization*, *accounts*, and *data
conventions* on top.

## Scope — 13 tasks (28 pts)

| Key | Task | Group | Wave | Pts |
|---|---|---|:--:|:--:|
| TM-103 | 2.4.1 `users` table + Flyway migration | 2.4 | 0 | 2 |
| TM-104 | 2.1.1 Backend CORS + web API base-URL config | 2.1 | 0 | 2 |
| TM-105 | 2.2.1 Firebase Auth client SDK in the web app | 2.2 | 0 | 2 |
| TM-107 | 2.2.4 Backend `GET /api/v1/me` (verified caller) | 2.2 | 1 | 1 |
| TM-106 | 2.2.2 Auth UI: sign-up / social / sign-out | 2.2 | 1 | 3 |
| TM-110 | 2.3.1 RBAC: Firebase custom claims → authorities | 2.3 | 1 | 2 |
| TM-114 | 2.5.2 Base entity: soft-delete + optimistic concurrency | 2.5 | 1 | 2 |
| TM-108 | 2.2.3 Web API client attaches the ID token (Bearer) | 2.2 | 2 | 2 |
| TM-112 | 2.4.2 JIT user provisioning + profile (`/api/v1/me`) | 2.4 | 2 | 2 |
| TM-113 | 2.5.1 Append-only audit log | 2.5 | 2 | 3 |
| TM-115 | 2.5.3 List conventions: pagination/filtering/sorting | 2.5 | 2 | 2 |
| TM-109 | 2.2.5 Web protected routes / auth guard | 2.2 | 3 | 2 |
| TM-111 | 2.3.2 `@PreAuthorize` + admin user-management endpoints | 2.3 | 3 | 2 |

Each ticket carries a self-contained **Agent execution prompt** in its description (objective /
files / steps / constraints / verify / out-of-scope), same as Epic 1.

## Status — remaining (2026-06-22)

The login chain is live end-to-end (TM-103/104/105/106/107/108/109/112 merged; sign-up/login → `GET /api/v1/me` works against the deployed env). **5 backend tickets remain** — they complete the SPINE:

- **TM-110** (wave-1, ready) — RBAC: map Firebase custom claims → Spring authorities, so roles travel in the verified ID token.
- **TM-114** (wave-1, ready) — Reusable base entity: soft-delete + optimistic concurrency (`@Version`), so every table inherits safe deletes and stale-write `409`s.
- **TM-113** (wave-2, ← TM-103) — Append-only audit log of account/admin actions.
- **TM-115** (wave-2) — Standard list conventions: pagination / filtering / sorting.
- **TM-111** (wave-3, ← TM-110) — `@PreAuthorize` enforcement + admin user-management endpoints (list / enable / disable; `USER` → `403`).

Wave-1 (TM-110, TM-114) can be claimed in parallel **once pulled into the active sprint**.

## Dependency DAG (waves)

```
wave 0 (roots, no blockers):  TM-103  TM-104  TM-105
wave 1:  TM-107        (independent — uses Epic-1 auth filter)
         TM-106  ← TM-105
         TM-110        (extends Epic-1 auth filter)
         TM-114  ← TM-103
wave 2:  TM-108  ← TM-105, TM-104
         TM-112  ← TM-103, TM-107
         TM-113  ← TM-103
         TM-115        (pairs with TM-111)
wave 3:  TM-109  ← TM-106, TM-108
         TM-111  ← TM-110, TM-103
```

Roots to claim first when agents poll: **TM-103, TM-104, TM-105** (all wave-0, independent).

## Human / HITL prerequisites

- **TM-96** — make the Cloud Run backend reachable (public-access / org-policy decision) so the
  web app can call the API. Needed before the end-to-end login demo works against the deployed env
  (local `make up` works without it).
- **Firebase console** — enable the Auth providers (email/password + chosen social, e.g. Google).
- Carry-over HITLs from Epic 1: **TM-98** (GHAS), **TM-99** (preview backend).

## Definition of done (demoable at review)

- Fresh clone → `make up` → open web → **sign up / log in (email + social)** → authenticated home
  shows your identity from `GET /api/v1/me`.
- Account is persisted in `users` (JIT on first login); profile editable via `PATCH /api/v1/me`.
- An `ADMIN` can list + enable/disable users; a `USER` hitting admin routes gets `403`.
- Account/admin actions are written to the append-only audit log.
- Concurrent stale edits return `409`; soft-deleted rows are hidden + restorable; list endpoints
  paginate/sort consistently.

## Not in this epic

The first real product feature (FLESH / Epic 3) and anything product-specific. **Tenancy/teams**
is the leading candidate for Epic 3 (fits the name, stays generic one more epic) — to be decided.
