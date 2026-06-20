# Architecture Decision Records (ADRs)

Records of significant, hard-to-reverse decisions for TeamMarhaba — the *why*
behind a choice, captured at the time it was made. Each ADR is immutable once
**Accepted**; a later decision that changes course gets a **new** ADR that
supersedes the old one (the old one stays, marked superseded).

## Format

One file per decision: `ADR-NNNN-short-kebab-title.md`, starting with a header
block (`Status`, `Date`, `Ticket`) followed by **Context → Decision →
Consequences**. Status is one of: `Proposed`, `Accepted`, `Superseded by ADR-XXXX`.

## Index

| ADR | Title | Status | Ticket |
| --- | --- | --- | --- |
| [ADR-0001](ADR-0001-gradle-build-standard.md) | Gradle (Kotlin DSL) as the backend build tool | Accepted | TM-88 |

_Add a row here whenever you add an ADR._
