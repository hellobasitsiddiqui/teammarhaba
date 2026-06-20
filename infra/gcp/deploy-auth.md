# Deploy auth — GitHub OIDC → Workload Identity Federation (TM-67)

Keyless CI auth: GitHub Actions authenticates to GCP via **Workload Identity Federation**
(OIDC) and impersonates a least-privilege deploy service account. **No service-account JSON
key exists** anywhere (repo or CI secrets) — nothing to leak or rotate.

## Resources (project `teammarhaba`, number `58443206078`)

| Thing | Value |
| --- | --- |
| Workload Identity Pool | `github-pool` (global) |
| OIDC provider | `github-provider` — issuer `https://token.actions.githubusercontent.com` |
| Provider resource (CI `workload_identity_provider`) | `projects/58443206078/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| Deploy service account | `gha-deployer@teammarhaba.iam.gserviceaccount.com` |
| Trust scope | repos owned by `hellobasitsiddiqui` (attribute condition), SA impersonation bound to repo `hellobasitsiddiqui/teammarhaba` |

### Least-privilege roles on the deploy SA
`roles/run.admin` · `roles/artifactregistry.writer` · `roles/firebasehosting.admin` ·
`roles/secretmanager.secretAccessor` · `roles/iam.serviceAccountUser`
(Cloud Run deploy, Artifact Registry write, Hosting deploy, Secret Manager access, act-as runtime SA.)

## Reproduce (documented gcloud — IaC-as-docs)

```bash
PROJECT=teammarhaba
PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA="gha-deployer@${PROJECT}.iam.gserviceaccount.com"
REPO="hellobasitsiddiqui/teammarhaba"

# Pool + GitHub OIDC provider (trust scoped to the org)
gcloud iam workload-identity-pools create github-pool \
  --project="$PROJECT" --location=global --display-name="GitHub Actions pool"
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --project="$PROJECT" --location=global --workload-identity-pool=github-pool \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner=='hellobasitsiddiqui'"

# Deploy service account + least-privilege roles
gcloud iam service-accounts create gha-deployer \
  --project="$PROJECT" --display-name="GitHub Actions deployer"
for ROLE in roles/run.admin roles/artifactregistry.writer roles/firebasehosting.admin \
            roles/secretmanager.secretAccessor roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SA}" --role="$ROLE" --condition=None
done

# Let the repo's OIDC identity impersonate the SA (keyless)
gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$PROJECT" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PN}/locations/global/workloadIdentityPools/github-pool/attribute.repository/${REPO}"
```

## CI usage
`.github/workflows/oidc-smoke.yml` authenticates with `google-github-actions/auth` using the
`workload_identity_provider` + `service_account` above and `permissions: id-token: write`.
Deploy workflows (TM-55 / TM-60 / TM-61) reuse the same pattern — never a JSON key.
