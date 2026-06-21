# ADR-0003: Cloud Run (backend) + Firebase Hosting (web) for hosting

- **Status:** Accepted
- **Date:** 2026-06-20
- **Ticket:** TM-48 (records the decision made across TM-66 / TM-67 / deploy.yml)

## Context

TeamMarhaba is multi-surface: a Spring Boot API plus a static web front end (and native
shells that talk to the same API). We need somewhere to run the containerised backend and
somewhere to serve the web app, with keyless CI/CD and costs that scale to zero when idle.
Options considered:

- **Cloud Run (backend) + Firebase Hosting (web)** — serverless container + global static CDN.
- **GKE** — maximum control, but a cluster to operate is overkill at this stage.
- **A VM (Compute Engine)** — simplest mentally, but we own scaling, patching, and uptime.
- **App Engine** — viable, but Cloud Run's container model is more portable and standard.

## Decision

We will run the **backend as a container on Cloud Run** and serve the **web front end from
Firebase Hosting**.

Rationale:
- **Scale-to-zero** — Cloud Run bills per request and idles to zero; right for early, bursty,
  low-traffic usage.
- **Plain containers** — we ship a standard OCI image (multi-stage Dockerfile), so the runtime
  stays portable and not locked to a bespoke platform.
- **Firebase Hosting for static** — global CDN, automatic TLS, atomic deploys and rollbacks,
  and native preview channels for per-PR previews.
- **Keyless deploys** — GitHub Actions authenticate to GCP via Workload Identity Federation
  (OIDC); images are pushed to Artifact Registry and deployed with **no service-account JSON
  key** anywhere (see [ADR-0004](ADR-0004-auth-firebase.md) for the same keyless principle in
  auth).
- **Managed Postgres pairing** — Cloud Run attaches Cloud SQL over the IAM Auth Proxy
  (see [ADR-0002](ADR-0002-database-cloud-sql.md)).

## Consequences

- **Positive:** near-zero idle cost; no servers/clusters to patch; portable container image;
  keyless CI/CD; first-class preview environments.
- **Cost / trade-off:** cold starts on Cloud Run after idle (mitigable with min-instances at a
  cost); a hard request/response timeout and stateless-process model (no local disk state);
  two hosting surfaces (Cloud Run + Firebase) to configure rather than one.

## References

- TM-66 (GCP/Firebase project) · TM-67 (keyless GitHub→GCP OIDC) · TM-55 (Artifact Registry) ·
  TM-65 (PR preview environments)
- [ADR-0002](ADR-0002-database-cloud-sql.md) (datastore) ·
  [ADR-0004](ADR-0004-auth-firebase.md) (auth)
- `.github/workflows/deploy.yml`, `infra/gcp/`
