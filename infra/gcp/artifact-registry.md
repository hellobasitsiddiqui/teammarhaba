# Artifact Registry — container images (TM-55)

The Docker repository CI pushes backend (and future) images to, and Cloud Run
(TM-60) pulls from. Keyless: CI authenticates via Workload Identity Federation
(see [`deploy-auth.md`](./deploy-auth.md)) and the deploy SA's
`roles/artifactregistry.writer` — no JSON key.

## Resources (project `teammarhaba`, region `europe-west2`)

| Thing | Value |
| --- | --- |
| Repository | `containers` (format `DOCKER`, region `europe-west2`) |
| Registry host | `europe-west2-docker.pkg.dev` |
| Backend image | `europe-west2-docker.pkg.dev/teammarhaba/containers/backend` |
| Tags per build | `:<commit-sha>` (immutable, traceable) + `:latest` |

## Provenance / scope note

TM-66 (1.5.1) enabled the `artifactregistry.googleapis.com` **API** but did not
create a **repository**, and no other ticket owned that. Since a target repo is a
hard prerequisite for "build & push to Artifact Registry", the `containers` repo was
created and documented here as part of TM-55. See the `[finding → future improvement]`
on TM-55 — repo provisioning should get its own ticket (or fold into TM-66) on the
next replay so it isn't a side effect of the CI ticket.

## Reproduce (documented gcloud — IaC-as-docs)

```bash
gcloud artifacts repositories create containers \
  --project=teammarhaba \
  --repository-format=docker \
  --location=europe-west2 \
  --description="TeamMarhaba application container images (backend, etc.)"
```

## CI usage

`.github/workflows/ci.yml` job `backend-image`:
- Builds the backend image on every PR and on push to `main`.
- **Pushes only on push to `main`** (`:<sha>` + `:latest`); PRs build without pushing.
- Auth = `google-github-actions/auth` (WIF) → `token_format: access_token` →
  `docker/login-action` against `europe-west2-docker.pkg.dev` as `oauth2accesstoken`.
- Runs `needs: backend`, so only a commit that passed build + tests is imaged.

Cloud Run deploy (TM-60) consumes `…/containers/backend:<sha>`.
