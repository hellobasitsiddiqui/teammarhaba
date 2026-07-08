# TeamMarhaba

A multi-surface application: a one-page **web** app, a **WebView** wrapper, a native **Android** app, and a shared **backend**.

**Stack:** Java 21 / Spring Boot, Cloud SQL (Postgres), Firebase Auth, Cloud Run + Firebase Hosting.

## Directory map

| Path | Purpose |
| --- | --- |
| `/backend` | Java 21 / Spring Boot API service (Cloud Run) |
| `/web` | Web single-page front end (Firebase Hosting) |
| `/webview` | Shared WebView assets/wrapper for the native shells |
| `/android` | Native Android app |
| `/infra` | Infrastructure & deployment config (GCP, CI/CD) |
| `/scripts` | Developer & automation scripts |
| `/docs` | Architecture, decision records (ADRs), agent operating docs, and the core-journey wireflows ([`docs/design/wireflows/`](./docs/design/wireflows/index.md)) |

Each directory has its own README. Most are stubs at this stage — the foundation tickets fill them in.

## Local development

Run the whole stack — backend + web + Postgres — with one command. From a fresh
clone, no manual setup is needed:

```bash
make up                  # writes a working local-dev .env if absent, then builds + starts
```

- Backend: <http://127.0.0.1:8080/health>
- Web: <http://127.0.0.1:8081>
- Postgres: `127.0.0.1:5432` (data persists in the `pgdata` volume across restarts)

`make up` runs `make setup` first, which generates a git-ignored `.env` with throwaway
local-dev defaults (it never overwrites an existing `.env`). Edit that `.env` if you need
different local values. All ports bind to `127.0.0.1` only.

> The committed [`.env.example`](./.env.example) is the **production** contract (profile
> `prod`, a blank secret `DB_PASSWORD`) — it is the source of truth for *which* vars exist,
> not a runnable local config. Copying it would not boot locally, which is why `make setup`
> exists. Compose uses bare `${VAR}` refs with no defaults, so a missing var fails loudly
> rather than silently defaulting.

Stop the stack with `make down` (add `make down-v` to also wipe the database volume).

## Common commands

A [`Makefile`](./Makefile) is the single entry point for the whole mono-repo — thin wrappers
over Docker Compose and the backend's Maven wrapper, so you don't need to learn each surface's
tooling. Run `make` (or `make help`) to list everything.

| Command | What it does |
| --- | --- |
| `make setup` | Write a working local-dev `.env` if absent (idempotent; never clobbers yours) |
| `make up` | Bootstrap `.env` (via `setup`) then build + start the full stack in the background |
| `make down` | Stop the stack (keeps the DB volume; `make down-v` also wipes it) |
| `make logs` / `make ps` | Tail logs / show container status |
| `make build` | Build all surfaces: backend jar + container images |
| `make test` | Run the backend test suite + checks (`./mvnw verify`) |
| `make run` | Run the backend app on the host (Spring Boot, port 8080) |
| `make lint` / `make fmt` | Check / auto-apply formatting (Spotless — same check as CI) |

**Prerequisites:** Docker + Docker Compose v2 for the stack targets; JDK 21 for the host-side
backend targets (`test`/`lint`/`fmt`/`run`) — the backend uses the bundled `./mvnw`, so no
system Maven is needed. `make test` boots Testcontainers, so Docker must be running for it too.

## Testing

The fast PR gate (`ci.yml`) runs automatically. Everything heavier — the golden-path, soak,
load (k6), and per-feature e2e suites, across web / mobile-web / Android / iOS — is an
on-demand library: see [`docs/agents/TEST-SUITES.md`](./docs/agents/TEST-SUITES.md) for what
each suite is, how to fire it, and where the evidence lands.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for branch, commit, and PR conventions. In
short: branch off `main` as `<type>/TM-<id>-<slug>`, lead commits with the Jira key
(`TM-<id> …`), open a PR using the template, and make sure CI is green before review.
Supply-chain conventions (SHA-pinned Actions, SBOM) are in
[`docs/supply-chain.md`](./docs/supply-chain.md).

## License

Proprietary — © 2026 10xai, all rights reserved. See [`LICENSE`](./LICENSE).
