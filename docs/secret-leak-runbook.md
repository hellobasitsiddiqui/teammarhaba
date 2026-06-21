# Runbook: a secret was committed / leaked

What to do when a credential (API key, token, password, private key, connection string) is
committed to the repo, flagged by gitleaks/secret scanning, or otherwise exposed.

> **Assume any exposed secret is compromised.** Even if a commit is deleted seconds later, it
> may already be cached, cloned, or indexed. **Rotation is mandatory — removing the commit is
> not enough.**

## 1. Rotate first (most important)

Revoke and reissue the credential at its source, immediately:

| Secret | Where to rotate |
| --- | --- |
| Cloud SQL DB password | Reset in Cloud SQL, update the Secret Manager secret (`teammarhaba-db-app-password`), redeploy. |
| GCP service-account key | There shouldn't be one — we use keyless WIF/ADC. If a key exists, delete it in IAM and remove the source that created it. |
| Firebase / API keys | Regenerate in the Firebase/GCP console; update any consumer. |
| GitHub token / PAT | Revoke in GitHub settings → Developer settings; issue a new scoped one. |
| Any third-party token | Revoke in that provider's dashboard and reissue. |

Rotating invalidates the leaked value so the exposure no longer matters. Do this **before**
worrying about git history.

## 2. Contain

- If GitHub **push protection** blocked the push: don't bypass it. Remove the secret from the
  change and re-commit. Only a maintainer may bypass, and only for a confirmed false positive.
- If it already landed on a branch/PR: rotate (step 1), then remove it from the code (replace
  with a Secret Manager reference / `.env` placeholder) and force-update the branch.

## 3. Purge from history (after rotation)

Removing a value from the latest commit does **not** remove it from earlier commits. To scrub
history use [`git filter-repo`](https://github.com/newren/git-filter-repo) (preferred) or the
BFG Repo-Cleaner, then force-push. Coordinate with the team — history rewrites affect everyone.

```bash
git filter-repo --replace-text <(echo 'THE_LEAKED_VALUE==>REDACTED')
git push --force-with-lease
```

For a flagged GitHub secret-scanning alert, close it as **revoked** once rotation is done.

## 4. Prevent recurrence

- Keep real secrets out of the repo: the env contract [`.env.example`](../.env.example) holds
  **placeholders only**; real values come from Secret Manager / your local (git-ignored) `.env`.
- `.gitignore` already blocks `.env`, `*-key.json`, `*.pem`, etc.
- The `gitleaks` workflow (`.github/workflows/gitleaks.yml`) scans PRs as a backstop; the
  primary control is GitHub-native secret scanning + push protection (GHAS).
- Never paste secrets into PR descriptions, issues, comments, or logs.

## Controls in this repo

| Control | Type | Status |
| --- | --- | --- |
| GitHub secret scanning + push protection | Native, **blocking** (pre-receive) | Requires GitHub Advanced Security — enablement tracked as a HITL ticket |
| `gitleaks` CI job | Advisory (non-blocking) on PRs | Active (`.github/workflows/gitleaks.yml`) |
| `.gitignore` secret patterns | Preventative | Active |
| `.env.example` placeholders-only contract | Preventative | Active |
