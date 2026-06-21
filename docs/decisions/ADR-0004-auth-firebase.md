# ADR-0004: Firebase Authentication for identity

- **Status:** Accepted
- **Date:** 2026-06-20
- **Ticket:** TM-48 (records the decision made in TM-66 / TM-79)

## Context

TeamMarhaba needs user authentication across its surfaces (web + native shells) and a way for
the backend to trust the caller's identity on each request. We want to avoid building and
operating our own credential store (password hashing, reset flows, MFA, social login) and we
want the backend to verify identity without holding long-lived secrets. Options considered:

- **Firebase Authentication** — managed identity with client SDKs, social providers, and
  verifiable ID tokens; native to the chosen GCP/Firebase stack.
- **Roll our own (Spring Security + user table + JWT)** — full control, but we then own the
  entire credential lifecycle and its security.
- **A third-party IdP (Auth0/Okta/Cognito)** — capable, but adds another vendor and cost
  outside the GCP/Firebase stack we've already chosen for hosting and data.

## Decision

We will use **Firebase Authentication** as the identity provider.

Rationale:
- **Managed identity** — sign-in, social providers, password/reset flows, and MFA are handled
  by Firebase, not us.
- **Stateless, verifiable tokens** — clients obtain a Firebase **ID token** (a signed JWT) and
  send it as a `Bearer` token; the backend verifies it with the Firebase Admin SDK. No server
  session store is needed.
- **Keyless verification** — the Admin SDK verifies tokens using **Application Default
  Credentials** (the Cloud Run runtime service account) — no service-account JSON key is
  embedded (consistent with the keyless deploy in [ADR-0003](ADR-0003-hosting-cloud-run-firebase.md)).
- **Stack fit** — same GCP/Firebase project as hosting and data; one console, one billing
  account, one identity for the whole stack.

## Consequences

- **Positive:** no credential store to build or secure; stateless backend auth (scales with
  Cloud Run); keyless token verification; social/MFA available when needed.
- **Cost / trade-off:** identity is coupled to Firebase/GCP (migrating IdP later means
  re-issuing identities); the backend depends on Firebase's public keys / Admin SDK at runtime;
  token-expiry and clock-skew handling must be correct on the verification path (TM-79).

## References

- TM-66 (GCP/Firebase project, Auth enabled) · TM-79 (backend Firebase token verification) ·
  TM-74 (security filter chain / default-deny)
- [ADR-0002](ADR-0002-database-cloud-sql.md) (datastore) ·
  [ADR-0003](ADR-0003-hosting-cloud-run-firebase.md) (hosting)
- `backend` — Firebase Admin SDK dependency (`firebase-admin`), `app.firebase.project-id`
