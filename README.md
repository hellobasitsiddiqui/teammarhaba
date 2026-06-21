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
| `/docs` | Architecture, decision records (ADRs), and agent operating docs |

Each directory has its own README. Most are stubs at this stage — the foundation tickets fill them in.

## Local development

Run the whole stack — backend + web + Postgres — with one command via
[`docker-compose.yml`](./docker-compose.yml):

```bash
cp .env.example .env     # then set DB_PASSWORD (and any blanks) for local dev
docker compose up --build
```

- Backend: <http://127.0.0.1:8080/health>
- Web: <http://127.0.0.1:8081>
- Postgres: `127.0.0.1:5432` (data persists in the `pgdata` volume across restarts)

All ports bind to `127.0.0.1` only. Config comes from your `.env` (the contract in
[`.env.example`](./.env.example)); compose uses bare `${VAR}` refs, so a missing var
fails loudly rather than silently defaulting. Stop with `docker compose down` (add
`-v` to also wipe the database volume).

## Common commands

A [`Makefile`](./Makefile) is the single entry point for the whole mono-repo — thin wrappers
over Docker Compose and the backend's Maven wrapper, so you don't need to learn each surface's
tooling. Run `make` (or `make help`) to list everything.

| Command | What it does |
| --- | --- |
| `make up` | Build + start the full stack (postgres, backend, web) in the background |
| `make down` | Stop the stack (keeps the DB volume; `make down-v` also wipes it) |
| `make logs` / `make ps` | Tail logs / show container status |
| `make build` | Build all surfaces: backend jar + container images |
| `make test` | Run the backend test suite + checks (`./mvnw verify`) |
| `make run` | Run the backend app on the host (Spring Boot, port 8080) |
| `make lint` / `make fmt` | Check / auto-apply formatting (Spotless — same check as CI) |

**Prerequisites:** Docker + Docker Compose v2 for the stack targets; JDK 21 for the host-side
backend targets (`test`/`lint`/`fmt`/`run`) — the backend uses the bundled `./mvnw`, so no
system Maven is needed. `make test` boots Testcontainers, so Docker must be running for it too.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for branch, commit, and PR conventions. In
short: branch off `main` as `<type>/TM-<id>-<slug>`, lead commits with the Jira key
(`TM-<id> …`), open a PR using the template, and make sure CI is green before review.
Supply-chain conventions (SHA-pinned Actions, SBOM) are in
[`docs/supply-chain.md`](./docs/supply-chain.md).

## License

Proprietary — © 2026 10xai, all rights reserved. See [`LICENSE`](./LICENSE).
