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
| `ADMIN_BOOTSTRAP_EMAIL` | config (optional) | plain env (`vars.ADMIN_BOOTSTRAP_EMAIL`) |
| `MAIL_HOST` | config | plain env (`smtp.gmail.com`) — set only when mail is on |
| `MAIL_PORT` | config | plain env (`587`) — set only when mail is on |
| `MAIL_USERNAME` | config | plain env (`no-reply@10xai.co.uk`) — set only when mail is on |
| `DB_PASSWORD` | **secret** | Secret Manager `teammarhaba-db-app-password` |
| `MAIL_PASSWORD` | **secret** | Secret Manager `teammarhaba-mail-app-password` (email-code delivery, TM-249/TM-253) |

`PORT` is platform-provided by Cloud Run (not part of the contract).

> **`MAIL_*` is gated on its secret existing (TM-253).** The deploy adds the MAIL block
> (`MAIL_PASSWORD` secret + `MAIL_HOST`/`MAIL_PORT`/`MAIL_USERNAME` env) **only when the secret
> `teammarhaba-mail-app-password` exists** — because `--set-secrets` to a non-existent secret
> *fails the whole deploy*. Until a human creates it (TM-252, see below), the deploy stays green and
> the backend falls back to the logging mailer (no email sent). The env names map 1:1 to
> `spring.mail.*` in `application.yml` (`MAIL_HOST`→`spring.mail.host`, `MAIL_PORT`→`spring.mail.port`,
> `MAIL_USERNAME`→`spring.mail.username`, `MAIL_PASSWORD`→`spring.mail.password` — TM-249), so they
> must stay exactly as above.

## How it's delivered

- **Non-sensitive config** → `gcloud run deploy --set-env-vars=...` (plain values).
- **Sensitive values** → `--set-secrets=DB_PASSWORD=teammarhaba-db-app-password:latest`.
  Cloud Run reads the secret from Secret Manager at runtime using the service's dedicated
  **runtime SA** `teammarhaba-run@` (granted `secretmanager.secretAccessor` on just that
  secret — see `cloud-run.md`); the deploy passes only the secret **name**, never the value.
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

## Email-code app password — `teammarhaba-mail-app-password` (TM-252 / TM-253)

The Workspace SMTP **app password** that turns real email-code login delivery on (TM-249). This is
a **human-secret split** (see `docs/agents/conventions/AGENTIC-LESSONS.md`): the agent wired the
deploy/infra (this doc + `deploy.yml`); a **human** mints the credential behind their own 2FA and
pastes its value — it never passes through the agent, a transcript, or CI logs.

**Ordering — do this BEFORE the MAIL block can deploy.** `deploy.yml` is gated so it only wires
`MAIL_PASSWORD` when this secret exists (an absent secret = green deploy, logging fallback). To turn
delivery on, a human runs the three steps below; the next production deploy then picks the MAIL block up.

```bash
PROJECT=teammarhaba
RUN_SA="teammarhaba-run@${PROJECT}.iam.gserviceaccount.com"

# 1. Create the (empty) secret container — one-time.
gcloud secrets create teammarhaba-mail-app-password --project="$PROJECT" --replication-policy=automatic

# 2. Add the app-password VALUE as a version. Mint it first in the Google Workspace account
#    (no-reply@10xai.co.uk): enable 2-Step Verification → create an *app password* (16 chars).
#    Paste it at the prompt below (it is read from stdin — never put it on the command line,
#    in a file under version control, or anywhere a transcript captures it).
printf '%s' "<paste-the-16-char-app-password-here>" | \
  gcloud secrets versions add teammarhaba-mail-app-password --project="$PROJECT" --data-file=-

# 3. Let the Cloud Run RUNTIME service account read JUST this secret (scoped, least-privilege —
#    same pattern as the DB secret). Without this grant the container can't read it and boot fails
#    loudly once mail is enabled.
gcloud secrets add-iam-policy-binding teammarhaba-mail-app-password --project="$PROJECT" \
  --member="serviceAccount:${RUN_SA}" \
  --role="roles/secretmanager.secretAccessor"
```

The runtime SA is **`teammarhaba-run@teammarhaba.iam.gserviceaccount.com`** (see `cloud-run.md`)
— the same least-privilege identity the container runs as for the DB secret. Rotate the same way as
the DB password: `gcloud secrets versions add teammarhaba-mail-app-password --data-file=-`, then the
next deploy picks up `:latest`.

## Out of scope
- The validator implementation itself (TM-64 / 1.4.5).
- Provisioning Cloud SQL / Secret Manager (TM-63 / 1.4.4).
