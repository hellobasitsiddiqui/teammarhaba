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
