# Cloud SQL Postgres (TM-63)

The backend's production datastore. Config of record: [`config.yaml`](./config.yaml) → `cloud_sql`.

| | |
| --- | --- |
| **Instance** | `teammarhaba-pg` |
| **Connection name** | `teammarhaba:europe-west2:teammarhaba-pg` |
| **Version / tier** | POSTGRES_16 · Enterprise · `db-f1-micro` (shared-core) |
| **Region** | `europe-west2` (zonal) · 10 GB HDD · backups off (dev) |
| **Database / user** | `teammarhaba` / `app` |
| **Password** | Secret Manager: `teammarhaba-db-app-password` (never committed) |
| **Networking** | public IP, **no authorized networks** — reached only via the Cloud SQL Auth Proxy (IAM-gated). Strict private-IP hardening → **TM-95** |

## How it was provisioned (reproducible — `gcloud`)

```bash
PID=teammarhaba; INST=teammarhaba-pg

# Instance (Enterprise edition is required for the shared-core db-f1-micro tier)
gcloud sql instances create $INST --project=$PID \
  --edition=enterprise --database-version=POSTGRES_16 --tier=db-f1-micro \
  --region=europe-west2 --storage-type=HDD --storage-size=10 \
  --no-backup --availability-type=zonal --root-password=<generated>

# Database + app user (app password generated, not echoed)
gcloud sql databases create teammarhaba --instance=$INST --project=$PID
gcloud sql users create app --instance=$INST --project=$PID --password=<generated>

# Store the app password in Secret Manager
printf '%s' "<app-password>" | gcloud secrets create teammarhaba-db-app-password \
  --project=$PID --replication-policy=automatic --data-file=-
```

## Connecting from Cloud Run (TM-60, later)

Use Cloud Run's built-in Cloud SQL connection (Auth Proxy) — no public exposure:

```bash
gcloud run deploy <svc> --project=teammarhaba --region=europe-west2 \
  --add-cloudsql-instances=teammarhaba:europe-west2:teammarhaba-pg \
  --set-secrets=DB_PASSWORD=teammarhaba-db-app-password:latest \
  --set-env-vars=DB_NAME=teammarhaba,DB_USER=app,INSTANCE_CONNECTION_NAME=teammarhaba:europe-west2:teammarhaba-pg
# App connects over the Unix socket /cloudsql/<connection_name>.
```

## Cost control — start / stop (dev)

The instance bills compute while running; **stop it when idle** (storage still bills, ~£2/mo):

```bash
gcloud sql instances patch teammarhaba-pg --project=teammarhaba --activation-policy=NEVER    # stop
gcloud sql instances patch teammarhaba-pg --project=teammarhaba --activation-policy=ALWAYS   # start
```

## Out of scope
- Cloud Run deploy wiring (TM-60 / 1.4.1) and Flyway migration content (1.6.2) — so end-to-end "app boots against Cloud SQL" is verified there, not here.
- Private-IP + VPC connector hardening for pre-prod/prod (**TM-95**).
- Terraform (documented `gcloud` for now; IaC can replace it later).
