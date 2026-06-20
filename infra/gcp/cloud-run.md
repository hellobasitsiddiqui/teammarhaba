# Cloud Run — backend CD (TM-60 / 1.4.1)

The backend is continuously delivered to **Cloud Run** on every merge to `main`.
Cloud Run provides the managed runtime, HTTPS endpoint, and autoscaling.

| | |
| --- | --- |
| **Service** | `teammarhaba-backend` |
| **Region** | `europe-west2` |
| **Image** | `europe-west2-docker.pkg.dev/teammarhaba/containers/backend:<sha>` (from TM-55) |
| **Port** | 8080 (Spring binds Cloud Run's `PORT`) |
| **Scaling** | min `0` (scale-to-zero) · max `3` · startup CPU boost on |
| **Auth** | public (`--allow-unauthenticated`) — it's the app's API surface |

## How it deploys

`.github/workflows/deploy.yml` (job `backend`) runs on `push` to `main`:

1. **Auth** — keyless WIF (TM-67), impersonating `gha-deployer` (`roles/run.admin`,
   `secretmanager.secretAccessor`, `iam.serviceAccountUser`). No JSON key.
2. **Wait for image** — CI's `backend-image` job (`ci.yml`) pushes `:<sha>` on the
   same merge event, so the deploy polls Artifact Registry until that immutable tag
   exists (≈10 min cap) before deploying. If CI fails, the deploy times out and fails.
3. **Deploy** — `gcloud run deploy` of the SHA-tagged image with the config below.
4. **Smoke-check** — `GET <url>/health` expects `200` over HTTPS.

### Health probes (`/health`)

```
--startup-probe=httpGet.path=/health,httpGet.port=8080,initialDelaySeconds=10,timeoutSeconds=3,periodSeconds=10,failureThreshold=6
--liveness-probe=httpGet.path=/health,httpGet.port=8080,timeoutSeconds=3,periodSeconds=30,failureThreshold=3
```

Cloud Run **gates traffic on the startup probe** — a new revision receives traffic
only after `/health` passes, so an unhealthy revision never serves. The liveness
probe restarts a wedged container.

### Cloud SQL + secrets (pre-wired)

```
--add-cloudsql-instances=teammarhaba:europe-west2:teammarhaba-pg
--set-secrets=DB_PASSWORD=teammarhaba-db-app-password:latest
--set-env-vars=SPRING_PROFILES_ACTIVE=prod,DB_NAME=teammarhaba,DB_USER=app,INSTANCE_CONNECTION_NAME=teammarhaba:europe-west2:teammarhaba-pg
```

The Cloud SQL Auth Proxy socket is mounted at `/cloudsql/<connection_name>`. The app
does not consume the datasource yet (web-only skeleton, no JDBC driver); this wiring
is in place so the data-layer ticket only adds the driver + datasource URL. See
`backend/src/main/resources/application-prod.properties`.

## Cold-start upgrade

`min-instances=0` means a request after idle pays a JVM cold start (helped by
`--cpu-boost`). To remove cold starts (at the cost of an always-on instance), set a
warm floor:

```bash
gcloud run services update teammarhaba-backend --project=teammarhaba --region=europe-west2 --min-instances=1
```

## Rollback (previous revision)

Each deploy creates an immutable revision; roll back by shifting 100% traffic to a
known-good one — no rebuild.

```bash
# List revisions (newest first)
gcloud run revisions list --service=teammarhaba-backend --project=teammarhaba --region=europe-west2

# Point all traffic at a previous revision
gcloud run services update-traffic teammarhaba-backend --project=teammarhaba --region=europe-west2 \
  --to-revisions=<previous-revision>=100
```

Or `git revert <bad-merge> && git push` to roll forward with the repo matching prod.

## Out of scope
- App-side JDBC datasource / Flyway migrations (data-layer ticket) — the app has no DB driver yet.
- Per-PR Cloud Run preview revisions (TM-65 / 1.4.6).
- Locking the service down behind auth (currently public) — a later hardening ticket.
