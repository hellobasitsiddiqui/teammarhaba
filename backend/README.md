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

## Security headers (TM-78)

Every response carries a baseline set of security headers, emitted by
`SecurityHeadersFilter` (a plain servlet filter — no Spring Security / auth machinery
is on the classpath yet):

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
