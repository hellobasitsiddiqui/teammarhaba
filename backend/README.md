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
