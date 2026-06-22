# Glossary — agentic + engineering slang

Shared vocabulary for the fleet. Punchy definitions, grounded in TeamMarhaba where it helps. Part of the agent OS (travels with the replay). **Append a term whenever a useful bit of slang shows up.**

## Agentic / multi-agent
- **Agent fleet** (*swarm*) — many autonomous agents working one backlog concurrently (agent-A/B/C…).
- **Orchestrator** (*conductor*) — the coordinating agent: plans, sweeps the merge gate, resolves conflicts — doesn't write the feature code.
- **Blackboard** — append-only shared scratch agents read/write so no one re-learns what another found. (*Stigmergy*: coordinating by leaving marks in the shared environment, like ants with pheromones.)
- **Claim protocol / work-stealing** — idle agents *pull* the next ready ticket and lock it (status = the lock) instead of a central scheduler handing out work.
- **Merge gate** — the human-merge step where finished PRs queue; the fleet's real bottleneck.
- **Wave** — a layer of the dependency DAG; `wave-0` = no blockers (start here). Fleet width = the widest *ready* wave.
- **Critical path** — the longest dependency chain; it sets sprint length, not the total story points.
- **Fan-out / fan-in** (*scatter-gather*) — split work across agents, then synthesize.
- **HITL** (human-in-the-loop) — steps only a person can do (console toggles, billing, the merges).
- **Self-hosting / bootstrapping** — the fleet builds from the very repo that defines how it operates (chicken-and-egg, solved by a linear bootstrap).
- **Replay** — re-running the recorded tickets to rebuild (or improve) the system; scope = `labels = replay`.

## Testing & build
- **Hermetic testing** — tests that run in total isolation: no network, no shared/live services, fully reproducible — same inputs → same result, anywhere. *Ours:* Testcontainers spins a throwaway Postgres so the data layer is hermetic (no shared dev DB).
- **Walking skeleton** — the thinnest end-to-end slice that actually runs (TM-49: a `/health` Spring Boot service) — proves the whole pipe before adding meat.
- **Flaky test** — passes/fails non-deterministically (timing, ordering, shared state); quietly erodes trust in green.
- **Red / green · "main is red"** — build/test failing/passing; *main is red* = the default branch is broken — stop and fix before piling on.
- **Drift / drift check** — reality diverging from a committed contract (OpenAPI spec, DB schema, `.env.example`) + the CI guard that fails on it. A *git-invisible* drift: two Flyway migrations with the same `Vn` but different filenames — clean in git, broken at boot.
- **Canary** — a small/early run that surfaces breakage before it hits everyone (our nightly fresh-build canary).
- **Golden / snapshot file** — a committed expected-output the test diffs against.

## CD & ops
- **Stale rollout** — a deploy reports success but old code still serves (TM-131). Assert *serving revision == just-built*; don't trust a `/health` 200.
- **Blast radius** — how much breaks if this fails; keep it small (least-privilege, scoped tokens).
- **Fail loud / fail fast** — surface errors immediately (a boot-time secrets validator) rather than limping on with bad config.
- **Keyless / OIDC** — auth with short-lived federated tokens; no stored key or secret.
- **Idempotent** — safe to run twice with no extra effect (matters for retries and replays).

## Engineering wisdom (anti-patterns & rules)
- **YAGNI** ("You Aren't Gonna Need It") — don't build it until a real need forces it.
- **Premature abstraction** — generalizing from one example; you usually guess the wrong shape. Wait for ~3 real uses.
- **Yak shaving** — the chain of incidental sub-tasks you must finish before the actual task.
- **Bikeshedding** — arguing the trivial (the bike-shed's colour) while the hard thing goes undiscussed.
- **Toil** — repetitive manual work that should be automated — exactly what the fleet exists to absorb.
- **Dogfooding** — using your own product (the fleet self-hosting from its own repo).
- **Boy-scout rule** — leave the code cleaner than you found it.
- **Chesterton's fence** — don't remove something until you understand why it's there.
- **Blameless** — after a failure, fix the system, not the person.
- **Redlining / tombstoning / silent delete** — mark edits via strikethrough / leave struck-through retired content / remove with no trace (see the global `JARGON.md`).

_Living doc — add a term whenever a useful bit of slang shows up._
