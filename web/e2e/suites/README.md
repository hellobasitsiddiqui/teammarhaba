# On-demand suite scripts (`web/e2e/suites/`)

The `golden`, `soak`, and `load` suites of the on-demand test-suite library (epic TM-339) are dispatched by
`.github/workflows/test-suite.yml` (TM-340) to a script in this directory:

| suite  | script            | owner ticket |
| ------ | ----------------- | ------------ |
| golden | `golden.sh`       | TM-341       |
| soak   | `soak.sh`         | TM-342       |
| load   | `load.sh`         | TM-343       |

Until a script exists the workflow exits with a clear **"not implemented yet"** error naming the expected
path — so the owning ticket just drops its script in here with no workflow change.

## Contract (what the workflow passes in)

The script is invoked as `bash web/e2e/suites/<suite>.sh` from the `web/e2e` working directory, with:

- **`PW_PROJECT`** — the Playwright project for the requested surface (`chromium` for `web`,
  `mobile-chromium` for `mobile-web`). Pass it through as `--project="$PW_PROJECT"`.
- **`DURATION_MINUTES`** — soak duration passthrough (may be empty; default sensibly).
- **`VUS`** — load virtual-users / concurrency passthrough (may be empty; default sensibly).

The backend, Postgres, and the Firebase Auth/Storage emulators are already up (same stack as `e2e.yml`).

## Evidence

Write screenshots/reports under `web/e2e/playwright-report` and/or `web/e2e/test-results` (Playwright's
defaults) so the workflow's evidence step picks them up and attaches them to the Jira ticket. Run Playwright
with `--screenshot=on` so there is always at least one screenshot per test.

Exit non-zero on suite failure so the dispatch reflects pass/fail.
