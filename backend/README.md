# backend

Java 21 / Spring Boot API service for TeamMarhaba. Exposes the REST API, talks to Cloud SQL (Postgres), and verifies Firebase Auth tokens. Deployed to Cloud Run.

Stub — implementation lands in later tickets.

## Configuration & profiles (TM-70)

Config is YAML with one file per environment, selected by `SPRING_PROFILES_ACTIVE`:

- `application.yml` — shared base; defaults the active profile to `dev`.
- `application-dev.yml` — local dev (docker-compose Postgres, TM-52); safe defaults, zero setup.
- `application-test.yml` — automated tests; isolated defaults (Testcontainers harness in TM-57).
- `application-prod.yml` — Cloud Run; every value is **required from the environment**, no defaults.

App config binds to the validated `config.AppProperties` (`@ConfigurationProperties("app")`,
`@Validated`), so missing/blank required values **fail startup loudly**. The keys mirror the
`.env.example` contract (TM-62). The JDBC `DataSource` (driver + `spring.datasource`) lands with
the data layer (Flyway, TM-71) — there is no driver yet.

## API versioning (TM-70 → TM-77)

All application API endpoints are served under **`/api/v1`**. The prefix is applied **by
package**: any controller under `com.teammarhaba.backend.api` is automatically served beneath
`/api/v1` (see `api.ApiV1Config`). So put new API controllers in `...backend.api` and declare
only their sub-path (e.g. `@GetMapping("/widgets")` → `/api/v1/widgets`).

**Unversioned by design:** health probes (`/health` — the Cloud Run liveness/startup probe
target), actuator, and API docs live *outside* the `api` package and are not prefixed. They are
infrastructure, not the versioned API surface.

**Introducing `/api/v2`:** add a sibling configurer that prefixes a new
`com.teammarhaba.backend.api.v2` package with `/api/v2`, and add v2 controllers there. `/api/v1`
keeps serving in parallel, so a breaking change never disrupts existing clients.

## Observability — Actuator (TM-74)

Spring Boot Actuator exposes the operational surface over HTTP, split by sensitivity:

| Endpoint | Access | Notes |
| --- | --- | --- |
| `/actuator/health` | **public** | Liveness/readiness for orchestration. `show-details: when-authorized`, so anonymous callers see only `{"status":"UP"}` — never component internals (DB, disk, …). Liveness/readiness groups at `/actuator/health/{liveness,readiness}`. |
| `/actuator/info` | **authenticated** | Static app identity (`info.app.*`). |
| `/actuator/metrics` | **authenticated** | Micrometer metrics — JVM, HTTP server, and a sample custom `teammarhaba.app.info` (`config.MetricsConfig`). Exported to **Google Cloud Monitoring under prod** via the Stackdriver registry (off in dev/test); export uses the Cloud Run runtime SA — no key (TM-75). |

`/health` (the bare, unversioned controller) stays the lightweight probe the Cloud Run
deploy targets — kept separate from Actuator so changing the probe path never means changing
the deploy. Both report `UP`.

The public/authenticated split is enforced by `security.SecurityConfig` (the permit-list);
the Firebase ID-token auth that backs the *authenticated* half is layered on in TM-79.

## Authentication — Firebase ID tokens (TM-79)

The API is **default-deny**: every route requires an authenticated caller except a small
permit-list (`/health`, `/actuator/health`, and the OpenAPI docs in non-prod). Callers prove
identity with a **Firebase ID token** sent as `Authorization: Bearer <token>`.

- `auth.FirebaseAuthenticationFilter` verifies the token with the Firebase Admin SDK and, on
  success, sets a `VerifiedUser` (uid + email) as the security principal — read it in a handler
  with `@AuthenticationPrincipal VerifiedUser` (see `api.PingController`, `GET /api/v1/ping`).
- A missing or invalid token yields a uniform RFC 7807 **`401`** from `auth.RestAuthenticationEntryPoint`
  (same `application/problem+json` shape as every other error — TM-72).
- `auth.FirebaseConfig` initialises the Admin SDK from **Application Default Credentials** — the
  Cloud Run runtime service account in prod, `gcloud auth application-default login` locally.
  **No service-account key is committed.** The `FirebaseAuth` bean is lazy, so token-free requests
  (and the whole dev/test/CI boot, which has no credentials) never trigger initialisation.

The permit-list and stateless/CSRF-off config live in `security.SecurityConfig`. **Out of scope:**
login UI, the user/role model, and per-surface client SDKs.

## API docs — OpenAPI / Swagger UI (TM-76)

springdoc generates the OpenAPI spec from the live controllers, so every endpoint is documented
and explorable without hand-maintained docs:

| Surface | Path |
| --- | --- |
| OpenAPI JSON | `/v3/api-docs` |
| Swagger UI | `/swagger-ui` |

**Prod exposure:** both are **disabled on `prod`** (`application-prod.yml`) so the API's shape
isn't published on the public surface; they're enabled in dev/test. Re-enable behind auth later
if an internal docs surface is wanted. The endpoints are unauthenticated where enabled — when the
auth seam (TM-79) tightens access, keep `/v3/api-docs` and `/swagger-ui/**` permit-listed in
non-prod. Title/version metadata lives in `api.OpenApiConfig`. The OpenAPI drift-check CI job is
deferred to Epic 2 (it needs a real API surface).

## Security headers (TM-78)

Every response carries a baseline set of security headers, emitted by
`SecurityHeadersFilter` (a plain servlet filter). It stays a filter rather than Spring
Security header-writing even though Spring Security is now on the classpath (added in TM-74
for Actuator authorization): headers are a cross-cutting concern, and keeping them in one
filter means a single source of truth — Spring Security's own header writer is disabled in
`SecurityConfig` to avoid duplication. The headers:

| Header | Value | Notes |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | **Secure requests only.** Sent when the request is HTTPS or arrives with `X-Forwarded-Proto: https` (Cloud Run terminates TLS at the edge). Withheld on plaintext local dev so the browser isn't pinned to HTTPS. No `preload` — that's a hard-to-reverse commitment a reusable base shouldn't make. |
| `X-Frame-Options` | `DENY` | Legacy clickjacking protection. |
| `Content-Security-Policy` | `default-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'` | Starter policy (see below). |
| `X-Content-Type-Options` | `nosniff` | Stop MIME-type sniffing. |
| `Referrer-Policy` | `no-referrer` | Don't leak URLs in the `Referer` header. |

### The starter CSP

The backend serves JSON, not the web UI — the web single-page app is hosted on
Firebase Hosting on a **separate origin** (`teammarhaba.web.app`), so a CSP on API
responses does not constrain the web surface. The starter policy is therefore locked
down: deny by default, allow same-origin (`'self'`), forbid framing
(`frame-ancestors 'none'`, the modern superset of `X-Frame-Options`), and block
plugins (`object-src 'none'`).

If a future endpoint serves HTML/assets that need broader sources, tune the policy in
`SecurityHeadersFilter` (or lift it to per-route configuration) and extend the tests.
Per-route CSP tuning is intentionally out of scope here.
