# ADR-0001: Gradle (Kotlin DSL) as the backend build tool

- **Status:** Accepted
- **Date:** 2026-06-20
- **Ticket:** TM-88 (supersedes the Maven default introduced in TM-49)

## Context

TeamMarhaba is a multi-surface application that includes a **native `/android` app**, which
is Gradle-native. The initial backend walking skeleton (TM-49) used **Maven** simply as a
default. Running two JVM build systems — Maven for the backend, Gradle for Android — splits
the toolchain, the CI skillset, and the developer mental model across the repo.

## Decision

The backend builds with **Gradle using the Kotlin DSL** (`build.gradle.kts` + the Gradle
wrapper `./gradlew`). This is the build standard going forward and **supersedes Maven** for
the backend.

Rationale:
- **One build system** across all JVM surfaces (backend + Android).
- **One CI skillset** — workflows, caching, and wrapper handling are identical everywhere.
- **Kotlin DSL** gives type-safe, IDE-navigable build scripts.
- **Faster incremental builds** (Gradle build cache / configuration cache).

## Scope & timing

This ADR is a **decision record only — no code conversion is performed now.** The current
merged backend remains on Maven and is **throwaway on the planned redo**. On the redo / when
implemented:

- Backend uses the Gradle wrapper + `build.gradle.kts`; **no `pom.xml`**.
- `./gradlew build` / `./gradlew test` are green; the Spring Boot Gradle plugin produces the
  runnable jar/image.
- The backend Dockerfile (TM-50) and PR CI (TM-53) invoke **Gradle**, not Maven.
- Android keeps its native Gradle.

## Consequences

- **Positive:** unified JVM toolchain and CI, type-safe build scripts, faster incremental builds.
- **Cost:** a one-time conversion of the backend skeleton; contributors need Gradle familiarity;
  the Maven-based tickets (TM-49 skeleton, TM-50 Dockerfile, TM-53 CI) are redone against
  Gradle on the redo.

## References

- TM-88 (this decision) · TM-49 (Maven skeleton, superseded) · TM-50 (Dockerfile) · TM-53 (CI)
- `CLAUDE.md` → Conventions → Build tool
