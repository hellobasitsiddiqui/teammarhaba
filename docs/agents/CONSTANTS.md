# CONSTANTS — the one file you edit to re-skin (TM-138, absorbs TM-120)

**Replaying into a new project? Edit this file first.** Every project-specific identifier lives here, so a re-skin is "change these values, then run `GENESIS.md`." Nothing else in the **generic Agent OS** (see `SEED-MANIFEST.md` keep-list) should hard-code a project name or id — it should point back here.

> These are **TeamMarhaba's** values, filled in as the worked example. On a fresh project, overwrite the right-hand column.

## Identity
| Key | Value |
| --- | --- |
| Product / app name | **TeamMarhaba** |
| Repo (GitHub) | `hellobasitsiddiqui/teammarhaba` |
| Default branch | `main` |

## Jira
| Key | Value |
| --- | --- |
| Project key | `TM` |
| Cloud id | `643606a4-9782-44b5-8c0a-da960167a962` |
| Site | `10xai.atlassian.net` |
| Story-points field | `customfield_10016` |
| Sprint field | `customfield_10020` |
| Start-date field | `customfield_10015` |
| Flagged field | `customfield_10021` (`[{"value":"Impediment"}]`) |
| Transition ids | To Do `11` · In Progress `21` · In Review `31` · Backlog `41` · Done `51` |
| Issue-type ids | Task `10003` · Bug `10007` |

## GCP
| Key | Value |
| --- | --- |
| Project id | `teammarhaba` |
| Project number | `58443206078` |
| Region | `europe-west2` |
| Org | `10xai` (`103553953969`), Workspace customer `C0427lbt2` |
| Deploy SA (WIF impersonates) | `gha-deployer@teammarhaba.iam.gserviceaccount.com` |
| Runtime SA (Cloud Run runs as) | `teammarhaba-run@teammarhaba.iam.gserviceaccount.com` |
| WIF provider | `projects/58443206078/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |

## Services
| Key | Value |
| --- | --- |
| Backend (Cloud Run) | `teammarhaba-backend` |
| Backend image | `europe-west2-docker.pkg.dev/teammarhaba/containers/backend:<sha>` |
| Web (Firebase Hosting) | `teammarhaba.web.app` |
| Cloud SQL instance | `teammarhaba:europe-west2:teammarhaba-pg` |
| DB / user | `teammarhaba` / `app` |
| DB password secret | `teammarhaba-db-app-password` (Secret Manager) |

## App config (env / first-run)
| Key | Value |
| --- | --- |
| Firebase project id | `teammarhaba` (env `FIREBASE_PROJECT_ID`) |
| First-admin bootstrap | GitHub repo variable `ADMIN_BOOTSTRAP_EMAIL` → that account signs in once → deploy writes the ADMIN claim (needs runtime SA `firebaseauth.admin`; TM-140) |

> Full env contract: `backend/.env.example` (the 1.4.5 boot validator enforces it). Verified infra commands: `infra/gcp/cloud-run.md`, `infra/gcp/secrets-env.md`.
