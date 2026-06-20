# Secrets & environment delivery (TM-62 / 1.4.3)

How config and secrets reach the running backend — nothing secret is committed, and
no secret value passes through CI or its logs.

## The contract

[`/.env.example`](../../.env.example) is the **single source of truth** for the
required env vars. It is:

- what the **fail-loud validator** (TM-64 / 1.4.5) checks at boot — a missing
  required var stops startup loudly, and
- what the **Cloud Run deploy** (`.github/workflows/deploy.yml` → `backend`) injects.

Keep all three in sync: add a var → add it to `.env.example`, the deploy, and the
validator's required set.

| Var | Sensitivity | Source in production |
| --- | --- | --- |
| `SPRING_PROFILES_ACTIVE` | config | plain env (`prod`) |
| `DB_NAME` | config | plain env |
| `DB_USER` | config | plain env |
| `INSTANCE_CONNECTION_NAME` | config | plain env |
| `FIREBASE_PROJECT_ID` | config | plain env |
| `DB_PASSWORD` | **secret** | Secret Manager `teammarhaba-db-app-password` |

`PORT` is platform-provided by Cloud Run (not part of the contract).

## How it's delivered

- **Non-sensitive config** → `gcloud run deploy --set-env-vars=...` (plain values).
- **Sensitive values** → `--set-secrets=DB_PASSWORD=teammarhaba-db-app-password:latest`.
  Cloud Run reads the secret from Secret Manager at runtime using the service's
  runtime service account; the deploy passes only the secret **name**, never the value.
- **Deploy-time auth** → keyless Workload Identity Federation (TM-67). There is **no
  service-account key** and there are currently **no GitHub Actions secrets** required
  for the deploy.

## No secret in logs

- The DB password value never enters CI — only its Secret Manager *name* is referenced,
  so there is nothing for the runner to print or mask.
- If a future deploy-time secret is ever genuinely needed, store it as a **GitHub
  Actions secret** and reference it as `${{ secrets.NAME }}` — GitHub masks those in
  logs automatically. Never `echo` a secret, and never commit one.

## Rotating the DB password

```bash
# Add a new secret version, then redeploy (or let the next merge pick :latest up)
printf '%s' "<new-password>" | gcloud secrets versions add teammarhaba-db-app-password \
  --project=teammarhaba --data-file=-
```

`--set-secrets=...:latest` means the next deploy picks up the newest version.

## Out of scope
- The validator implementation itself (TM-64 / 1.4.5).
- Provisioning Cloud SQL / Secret Manager (TM-63 / 1.4.4).
