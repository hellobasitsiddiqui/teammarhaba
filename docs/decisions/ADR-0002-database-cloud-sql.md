# ADR-0002: Cloud SQL (PostgreSQL) as the primary datastore

- **Status:** Accepted
- **Date:** 2026-06-20
- **Ticket:** TM-48 (records the decision made in TM-63 / 1.4.4)

## Context

TeamMarhaba needs a durable, relational store for application data. The backend is a Spring
Boot service on Cloud Run (see [ADR-0003](ADR-0003-hosting-cloud-run-firebase.md)), so the
datastore must be reachable from Cloud Run, secured without long-lived credentials, and
operable by a small team without dedicated DBAs. Options considered:

- **Cloud SQL (managed PostgreSQL)** — managed backups/patching/HA, IAM-gated access.
- **Self-managed Postgres on a VM** — full control, but we own patching, backups, and uptime.
- **Firestore / a NoSQL store** — serverless and elastic, but the domain is relational and we
  want SQL, transactions, and migrations.
- **AlloyDB** — Postgres-compatible and faster, but heavier and costlier than this stage needs.

## Decision

We will use **Cloud SQL for PostgreSQL** as the primary datastore.

Rationale:
- **Managed operations** — automated backups, patching, and optional HA; no VM to babysit.
- **Relational + SQL** — the domain is relational; we want transactions, constraints, and
  versioned schema migrations (Flyway).
- **Keyless, IAM-gated access** — the backend connects via the Cloud SQL connector
  (`postgres-socket-factory`) over the IAM Auth Proxy socket: no public IP, no host/port, and
  no database password embedded in the image. The DB password is held in Secret Manager and
  injected at deploy time.
- **PostgreSQL portability** — standard Postgres keeps us portable (AlloyDB / another host)
  later if scale demands it.

## Consequences

- **Positive:** minimal ops burden; secure-by-default connectivity (no public IP, no static
  keys); first-class Flyway migrations; a clear path to AlloyDB if we outgrow Cloud SQL.
- **Cost / trade-off:** a running Cloud SQL instance costs more than a serverless store at
  near-zero traffic; connections go through the Auth Proxy socket factory (a small amount of
  connection-setup complexity, already encapsulated in `application-prod.yml`). Schema changes
  must go through Flyway migrations, not ad-hoc DDL — Hibernate is `ddl-auto: validate` only.

## References

- TM-63 (Cloud SQL + connector + Secret Manager) · TM-71 (data layer / Flyway) ·
  TM-64 (fail-loud config validation)
- [ADR-0003](ADR-0003-hosting-cloud-run-firebase.md) (hosting) ·
  [ADR-0004](ADR-0004-auth-firebase.md) (auth)
- `backend/src/main/resources/application-prod.yml` (datasource + connector config)
