# Contributing to TeamMarhaba

This repo is worked by both people and autonomous agents, so the conventions below are
kept deliberately simple and machine-checkable. The same rules apply to everyone.

> **License note:** TeamMarhaba is proprietary (see [`LICENSE`](./LICENSE)). Contributions
> are accepted only from authorised collaborators; by pushing you agree your changes are
> assigned to the project owner.

---

## Branching

- Never commit directly to `main` — it's protected and only moves via merged PRs.
- Branch off the latest `main`. Name the branch `<type>/TM-<id>-<short-slug>`:

  ```
  feat/TM-71-data-layer
  fix/TM-79-token-clock-skew
  chore/TM-46-repo-hygiene
  docs/TM-48-architecture
  ```

  Types: `feat` (new behaviour), `fix` (bug), `chore` (build/CI/tooling/hygiene),
  `docs` (docs only), `refactor` (no behaviour change), `test` (tests only).
- One ticket per branch. If a change grows beyond its ticket, split it.

## Commits

- Format: `TM-<id> <imperative summary>` — present tense, no trailing period.

  ```
  TM-46 Add repo-hygiene files (LICENSE, CODEOWNERS, templates)
  TM-59 Pin action SHAs and emit CycloneDX SBOM
  ```

- Lead every commit with the Jira key so history is traceable to the board.
- Keep commits focused; prefer a few logical commits over one giant blob.
- Never commit secrets, real `.env` files, or service-account keys — `.gitignore`
  blocks the common cases and CI secret-scanning (TM-58) is the backstop, but the
  first line of defence is you. The env contract lives in [`.env.example`](./.env.example)
  with placeholders only.

## Pull requests

1. Push your branch and open a PR against `main`.
2. **Title:** `TM-<id> <description>` (same style as the commit subject).
3. **Body:** fill in the [PR template](./.github/PULL_REQUEST_TEMPLATE.md) — what changed,
   why, how it was verified, and the Jira link.
4. Keep PRs scoped to a single ticket; small PRs review faster.
5. **CI must be green** before review — the backend build/test job, plus the security
   and supply-chain checks. Don't request review on a red PR. **Agent-authored PRs open as
   `draft`; the moment their checks go green, flip them to "Ready for review"** (draft =
   unverified, ready = verified). Marking ready is *not* merging — the merge stays a maintainer's call.
6. **CODEOWNERS** are requested automatically; at least one owner approval is required.
7. Address review comments by pushing follow-up commits (don't force-push away history
   mid-review unless asked).
8. **Merging is done by a maintainer**, not the author — a merge to `main` moves the ticket to
   **Testing** (the QA gate), **not** straight to Done. **Done is set only after Testing passes.**
   Lifecycle: **In Progress → In Review** (PR open) **→ Testing** (merged) **→ Done** (QA passed).
   This is enforced automatically by the Jira merge/reconcile Actions, so it holds for every PR,
   from everyone — not a manual habit.

## Local development

See the [README](./README.md#local-development) for the one-command Docker Compose stack
(a dev command runner for common tasks is coming in TM-69). Run the backend's checks the
way CI does before pushing:

```bash
cd backend && ./mvnw -B verify
```

This runs Spotless (format gate), the test suite, and produces the CycloneDX SBOM.

## Testing — tests land before code (test-first)

**Every behaviour change — bug fix _or_ new feature — is written test-first.** Write the test at
the right layer, commit it so it **fails on the current code** (red), then write the code that
makes it pass (green). This is a hard **Definition of Done** for people and agents alike: a
`feat`/`fix` PR without a failing-first test that now passes is **not complete**. A refactor is
the one exception — see below.

### Bug fixes ship with a regression test

Before changing the code, add a test that **reproduces the defect** — it must **fail on the
current code** and **pass once the fix lands**. This proves the fix works and stops the bug ever
silently coming back.

- Put the test where the logic is testable. If the defect lives in a side-effectful module,
  **extract the pure logic** into its own module and test that (e.g. `settleOrFallback` was pulled
  out of `router.js` into `async-util.js` to backfill the TM-307 login-dead-end guard).
- Name the test after the defect so the guard is self-documenting (reference the ticket).

### Features ship with tests proving each acceptance criterion

A feature PR carries tests that **prove each acceptance criterion** on the ticket, written
*before* the implementation. Work criterion by criterion: write the test for the next AC, watch
it fail, implement until it passes, repeat. A feature whose ACs aren't each pinned by a test is
not done — "it works when I click around" is not evidence.

### Choose the right layer

- **Pure logic** → unit test: web `web/tools/*.test.mjs` (`node --test`), backend `*Test.java`
  (JUnit).
- **Cross-component / DB / HTTP** → integration test: backend `*IntegrationTest.java` (Spring
  Boot + Testcontainers Postgres harness).
- **User-facing flow** → e2e: `web/e2e/tests/*.spec.mjs` (Playwright).

Prefer the fastest layer the logic allows — a unit test over an integration test, an integration
test over an e2e. Add an e2e only when the behaviour is genuinely end-to-end.

### Refactor exception — behaviour-preserving, no new tests

A `refactor` PR changes **no behaviour**, so it does **not** add new tests. Its proof is the
existing suite staying **green and unchanged** — unchanged tests passing *is* the evidence of
behaviour preservation. If you find yourself changing a test to make a "refactor" pass, it isn't
a refactor: it's a behaviour change and belongs in a `feat`/`fix` PR, test-first. See
[Refactoring](#refactoring) below.

### CI guard

[`test-first-guard.yml`](./.github/workflows/test-first-guard.yml) enforces the cheap
approximation on every PR: a `feat`/`fix` branch that touches production source
(`backend/src/main/**`, `web/src/**`) but **no test file** (`*Test.java`, `*.test.mjs`,
`web/e2e/tests/**`) fails with a pointer back here. `refactor`/`docs`/`chore`/`test` branches are
exempt. For the rare legitimate exception (e.g. a config-only fix with nothing testable), apply
the **`no-test-justified`** label and say why in the PR body — the guard then skips. If the guard
can't tell what type a PR is, it warns instead of blocking.

## Refactoring

Refactoring is a first-class change type (`refactor/TM-<id>-…` branches), with its own rules —
they pair with the test-first rule above:

- **A refactor goes in its own PR**, separate from any behaviour change. Never mix a refactor
  with a feature or fix — the reviewer can't tell the safe mechanical moves from the risky
  behavioural ones.
- **The proof of a refactor is the unchanged, still-green test suite.** A refactor PR must not
  change test assertions — changed tests = a behaviour change, which belongs in a `feat`/`fix`
  PR. (This is exactly why the CI test-first guard exempts `refactor` PRs.)
- **Small, named steps** (Extract Function, Rename, Move…) over one giant rewrite — a sequence of
  obvious moves reviews in minutes; a big-bang rewrite doesn't.
- **Refactoring untested code:** write **characterization tests first** to pin the current
  behaviour, then refactor under them. Never refactor untested code blind.
- **Boy Scout Rule:** small opportunistic cleanups riding along in a feature PR are welcome, but
  anything non-trivial gets its own `refactor` PR.

## API contract (OpenAPI drift check)

The REST API is pinned by a committed spec, `backend/openapi.json`, guarded by `OpenApiDriftTest`
(part of `verify`, so it runs in CI on every PR — TM-135). **Changed a controller / request /
response?** Regenerate the spec and commit it, or the build fails:

```bash
cd backend && ./mvnw -Dtest=OpenApiDriftTest -Dopenapi.generate=true -Dspotless.check.skip=true test
git add openapi.json
```

This keeps every API change intentional, reviewable in the diff, and impossible to ship by accident.

## Release versioning (build stamp)

The live web page and the backend `/version` endpoint show a build name derived from
`git describe --tags` (TM-142 / TM-155) — e.g. `v1.4.0-12-ged338a9`: the nearest release
tag, commits since it, and the exact short SHA. Until the repo has any tag it shows the bare
short SHA, so nothing breaks day-one. The exact commit is always recoverable from the string.

To cut a readable release version, tag `main` and push the tag:

```bash
git tag v1.4.0          # annotated is fine too: git tag -a v1.4.0 -m "1.4.0"
git push origin v1.4.0
```

The next deploy (web) and image build (backend) pick the tag up automatically — no code
change. Use `vMAJOR.MINOR.PATCH`. The CI image build and the deploy both check out full
history + tags (`fetch-depth: 0`) so `git describe` can see them.

**Tagging policy — tag deliberate releases only, *not* every deploy.** A tag means "this is a
release worth naming" (a notable feature, a demo, end-of-sprint). Between tags, `git describe`
already shows `vX.Y.Z-N-gSHA` — the *distance* (`-N-`) is the useful signal. Tagging every merge
makes the numbers meaningless and floods the tag list. You never need a tag to identify or roll
back a deploy: the SHA is in the build stamp, CI tags the image by SHA, and Cloud Run keeps every
revision (roll back by revision). SemVer: **patch** = fix, **minor** = feature, **major** = breaking.

## Switching the live theme

The web app ships three visual themes — `clean`, `doodle` and `sketch` — and the active one is chosen
by an operator at deploy time, with **no code change** (TM-212). The deploy injects the theme into the
built `web/src/assets/config.js` the same way it injects the backend API URL and build stamp, so it
surfaces as `window.TEAMMARHABA_CONFIG.theme`.

**To switch the live theme, set the `THEME` repo variable to `sketch`, `doodle` or `clean` and redeploy.**

```
Settings → Secrets and variables → Actions → Variables → New repository variable
  Name:  THEME
  Value: sketch      # or: doodle, clean
```

Then run the **Deploy** workflow (Actions → Deploy → Run) — the next deploy reads `vars.THEME` and
bakes it into the live `config.js`. The value is passed through as-is; the web app falls back to
`sketch` for any unknown value, so you don't need to validate it here.

**Default is `sketch`** (the hand-drawn pencil-sketch wireframe — the product direction; TM-323). If
the `THEME` variable is unset, the deploy injects `sketch`, so the live site has a defined theme
day-one without anyone touching the variable. To switch, set `THEME=doodle` or `THEME=clean` and
redeploy. Like the build stamp, the value is resolved at deploy time and never hardcoded in the repo.

## Conventions reference

- **Code style** is enforced by Spotless (backend) — CI fails on violations, so format
  before pushing (`./mvnw spotless:apply`).
- **Supply chain:** GitHub Actions are pinned to commit SHAs; see
  [`docs/supply-chain.md`](./docs/supply-chain.md) for the policy and how to bump a pin.
- **Architecture & decisions:** [`docs/decisions/`](./docs/decisions) (ADRs) and the
  agent operating docs in [`docs/agents/`](./docs/agents).
