# Security Policy

TeamMarhaba is proprietary software (see [`LICENSE`](./LICENSE)). We take the security of the
project and its users seriously. This document explains how to report a vulnerability and what
to expect in return.

## Supported versions

The project is in active development; only the latest state of the `main` branch (and what is
deployed from it) is supported. Fixes are applied to `main` and rolled forward — there are no
maintained back-branches at this stage.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems**, and do not disclose the
issue publicly until it has been resolved.

Report privately through either channel:

1. **GitHub private vulnerability reporting** (preferred) — go to the repository's **Security**
   tab → **Report a vulnerability**. This opens a private advisory visible only to maintainers.
2. **Email** — contact the maintainer at **basit@10xai.co.uk** with the details below.

Please include, as far as you can:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, affected endpoint/surface, request samples).
- The affected surface (backend / web / webview / android) and any version/commit SHA.
- Any suggested remediation.

## What to expect

- **Acknowledgement** within **3 business days** of your report.
- An initial **assessment** (severity + whether we can reproduce it) within **10 business days**.
- We'll keep you updated on remediation progress and let you know when a fix is released.
- We practise **coordinated disclosure**: please give us reasonable time to ship a fix before
  any public discussion. We're happy to credit reporters who want acknowledgement.

## Scope

In scope: the code in this repository and the services it deploys (the Cloud Run backend and
the hosted web front end). Out of scope: third-party services we depend on (GCP, Firebase,
GitHub) — report those to the respective vendor — and findings that require physical access or
a compromised end-user device.

## Our security posture

A few practices that are relevant when assessing a report:

- **Keyless by default** — CI/CD and runtime use Workload Identity Federation / Application
  Default Credentials; no service-account JSON keys exist in the repo or images.
- **Secrets** never live in the repo — the env contract ([`.env.example`](./.env.example)) holds
  placeholders only; real secrets come from Secret Manager. Secret scanning + push protection
  guard against accidental commits.
- **Default-deny auth** — the backend rejects unauthenticated requests except for health probes;
  identity is a verified Firebase ID token (see [ADR-0004](docs/decisions/ADR-0004-auth-firebase.md)).
- **Supply chain** — GitHub Actions are pinned to commit SHAs and each build emits a CycloneDX
  SBOM (see [`docs/supply-chain.md`](docs/supply-chain.md)); dependencies are scanned.
