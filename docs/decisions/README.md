# Architecture Decision Records (ADRs)

Records of significant, hard-to-reverse decisions for TeamMarhaba — the *why*
behind a choice, captured at the time it was made. Each ADR is immutable once
**Accepted**; a later decision that changes course gets a **new** ADR that
supersedes the old one (the old one stays, marked superseded).

## Format

One file per decision: `ADR-NNNN-short-kebab-title.md`, starting with a header
block (`Status`, `Date`, `Ticket`) followed by **Context → Decision →
Consequences**. Status is one of: `Proposed`, `Accepted`, `Superseded by ADR-XXXX`.
Start from [`ADR-0000-template.md`](ADR-0000-template.md).

## Index

| ADR | Title | Status | Ticket |
| --- | --- | --- | --- |
| [ADR-0000](ADR-0000-template.md) | Template (copy for new ADRs) | — | — |
| [ADR-0001](ADR-0001-gradle-build-standard.md) | Gradle (Kotlin DSL) as the backend build tool | Accepted | TM-88 |
| [ADR-0002](ADR-0002-database-cloud-sql.md) | Cloud SQL (PostgreSQL) as the primary datastore | Accepted | TM-48 |
| [ADR-0003](ADR-0003-hosting-cloud-run-firebase.md) | Cloud Run (backend) + Firebase Hosting (web) | Accepted | TM-48 |
| [ADR-0004](ADR-0004-auth-firebase.md) | Firebase Authentication for identity | Accepted | TM-48 |

_Add a row here whenever you add an ADR._
