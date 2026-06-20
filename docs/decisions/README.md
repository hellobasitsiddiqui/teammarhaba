# Architecture Decision Records (ADRs)

Short, dated records of significant technical decisions and their rationale. Each ADR
captures the context, the decision, and its consequences so future contributors can see
**why** something is the way it is — not just what it is.

## Index

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [ADR-0001](./ADR-0001-gradle-build-standard.md) | Gradle (Kotlin DSL) as the backend build tool | Accepted | 2026-06-20 |

## Conventions

- **Filename:** `ADR-NNNN-short-kebab-title.md` (zero-padded sequential number).
- **Status:** one of `Proposed`, `Accepted`, `Superseded` (link the superseding ADR), or `Deprecated`.
- **Structure:** Status / Date / Ticket header, then `## Context`, `## Decision`, `## Consequences`
  (or `## Scope & timing`). Keep it concise — an ADR records a decision, not a design doc.
- **Add a row here** whenever you add an ADR, so this index stays the single entry point.
