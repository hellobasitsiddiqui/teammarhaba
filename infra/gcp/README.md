# GCP / Firebase project (TM-66)

The `teammarhaba` Google Cloud + Firebase project that the deploys and the auth
seam build on. Config of record: [`config.yaml`](./config.yaml).

| | |
| --- | --- |
| **Project ID** | `teammarhaba` |
| **Project number** | `58443206078` |
| **Display name** | TeamMarhaba |
| **Default region** | `europe-west2` |
| **Billing** | linked (`01D78A-BEFF21-4B5232`) |
| **Plan** | Spark (upgrade to Blaze when Cloud SQL / Cloud Run land) |

## How it was provisioned (reproducible — `gcloud`)

```bash
# 1. Project
gcloud projects create teammarhaba --name="TeamMarhaba"

# 2. Billing
gcloud billing projects link teammarhaba --billing-account=01D78A-BEFF21-4B5232

# 3. APIs
gcloud services enable \
  run.googleapis.com sqladmin.googleapis.com firebasehosting.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com \
  firebase.googleapis.com identitytoolkit.googleapis.com \
  --project=teammarhaba
```

## Manual (console) steps — Firebase + Auth

The `firebase:addFirebase` REST/CLI call returned **403** for this account even as
project Owner with `roles/firebase.admin` and the `firebase` OAuth scope (likely an
org policy / console-only consent). So these two were done in the Firebase console:

1. **Add Firebase to the existing project** — console.firebase.google.com → *Add
   project* → **"Add Firebase to an existing Google Cloud project"** → select
   **`teammarhaba`** (do **not** create a new project — that silently makes a
   suffixed `teammarhaba-xxxxx` and splits the setup).
2. **Authentication → Sign-in method** → enable **Google** (set support email).

Both are verified via the Firebase Management + Identity Toolkit APIs (project
returns `ACTIVE`; `defaultSupportedIdpConfigs` shows `google.com` enabled).

## Out of scope (later tickets)

- Service account + GitHub OIDC (TM-67 / 1.5.2)
- Cloud SQL instance + connector + Secret Manager wiring (TM-63 / 1.4.4)
- Cloud Run / Firebase Hosting deploys (TM-60 / TM-61)
- Terraform (this is documented `gcloud`; IaC can replace it later)
