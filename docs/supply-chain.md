# Supply-chain hardening

How TeamMarhaba keeps its build inputs trustworthy: every GitHub Action is pinned to an
immutable commit SHA, and every backend build emits a CycloneDX SBOM so we can always
answer "what's in it?" / "are we exposed to CVE-X?".

This is the reference for **TM-59**. CONTRIBUTING.md (TM-46) cross-links here for the
day-to-day "how do I bump a pin" step.

---

## 1. Pinned action SHAs

### Policy

Every `uses:` in `.github/workflows/*.yml` references a **full 40-char commit SHA**, never a
moving tag (`@v4`) or branch (`@main`). A tag can be re-pointed by the action's owner after we
review it; a commit SHA cannot. Pinning to the SHA means the bytes we audited are the bytes CI
runs — a tag/branch ref would let a compromised or simply changed upstream run arbitrary code
in our pipeline with our `id-token`/registry permissions.

Each pin carries a trailing comment with the human-readable version it resolved from, so the
file stays readable and Dependabot/Renovate can still match it:

```yaml
uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
```

Rules:
- **No moving refs.** No `@vN`, `@main`, `@master`, or short SHAs in any workflow.
- **Keep the `# vX.Y.Z` comment.** It's the only readable provenance of what the SHA is.
- The same rule applies to **reusable workflows** (`uses: org/repo/.github/workflows/x.yml@<sha>`)
  and to Docker base images where practical (digest-pin `FROM ...@sha256:...`).

### How to update a pin

When bumping an action to a new version, resolve the tag to its commit SHA and pin that —
don't paste the tag.

1. Find the SHA the tag points at:
   ```bash
   gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq '.object.sha'
   # e.g. gh api repos/actions/checkout/git/refs/tags/v4.2.2 --jq '.object.sha'
   ```
2. If that returns an **annotated** tag (`.object.type == "tag"`, common for `actions/*`),
   dereference it to the underlying commit:
   ```bash
   gh api repos/<owner>/<repo>/git/tags/<sha-from-step-1> --jq '.object.sha'
   ```
   One-liner that handles both lightweight and annotated tags:
   ```bash
   gh api repos/actions/checkout/git/refs/tags/v4.2.2 \
     --jq 'if .object.type=="tag"
           then .object.url else .object.url end' \
     | xargs -I{} gh api {} --jq '.object.sha'
   ```
3. Replace the SHA in the workflow and update the trailing `# vX.Y.Z` comment to match.
4. `actionlint` (CI) and review confirm the pin is well-formed.

### Current pins

All four workflows are fully SHA-pinned (verified for TM-59):

| Workflow | Actions pinned |
|---|---|
| `ci.yml` | checkout, setup-java, action-junit-report, upload-artifact, setup-buildx, google-github-actions/auth, docker/login-action, docker/build-push-action |
| `deploy.yml` | checkout, google-github-actions/auth + setup-gcloud, docker actions |
| `oidc-smoke.yml` | checkout, google-github-actions/auth |
| `jira-merge-to-testing.yml` | (no `uses:` — pure `gh`/`curl` script) |

---

## 2. Software Bill of Materials (SBOM)

### What

The backend build emits a **CycloneDX** SBOM — a machine-readable list of every dependency
(group, artifact, version, license, hash) that ends up in the application. It's the input a
scanner uses to answer "are we shipping a vulnerable version of X?" without re-resolving the
build.

### How it's produced

`cyclonedx-maven-plugin` (in `backend/pom.xml`) binds `makeBom` to the **package** phase, so any
`./mvnw verify` / `./mvnw package` writes:

```
backend/target/bom.json   # CycloneDX 1.5, JSON
```

No extra command is needed — a normal build produces it. To generate it on its own:

```bash
cd backend && ./mvnw -B package -DskipTests
cat target/bom.json | jq '.metadata.component.name, (.components | length)'
```

### Where CI keeps it

The `backend` job in `ci.yml` uploads `backend/target/bom.json` as the **`backend-sbom`**
build artifact on every run (`if: always()`), so each commit's SBOM is retrievable from the
Actions run for provenance / CVE-exposure checks.

### Updating

Nothing to maintain by hand — the SBOM regenerates from the resolved dependency tree on every
build. When dependencies change, the next build's `backend-sbom` reflects them automatically.
