# On-demand suite scripts (`web/e2e/suites/`)

The `golden`, `soak`, and `load` suites of the on-demand test-suite library (epic TM-339) are dispatched by
`.github/workflows/test-suite.yml` (TM-340) to a script in this directory:

| suite  | script            | owner ticket | status         |
| ------ | ----------------- | ------------ | -------------- |
| golden | `golden.sh`       | TM-341       | ✅ implemented |
| soak   | `soak.sh`         | TM-342       | ✅ implemented |
| load   | `load.sh`         | TM-343       | not yet        |

Until a script exists the workflow exits with a clear **"not implemented yet"** error naming the expected
path — so the owning ticket just drops its script in here with no workflow change.

`golden.sh` runs the single `@golden` end-to-end journey (`tests/golden-path.spec.mjs`) on the requested
surface's project (`chromium` / `mobile-chromium`) — the whole happy path in one run as living evidence.

`soak.sh` LOOPS that same `@golden` journey back-to-back until `DURATION_MINUTES` (default 10) elapses,
to surface what a single pass can't — leaks, gradual degradation, intermittent flakiness. It records
pass/fail + wall-clock seconds per iteration, then emits a summary (iterations, pass/fail, min/max/avg)
and flags either a failed iteration (hard, exit non-zero) or **upward latency drift** — last-quartile
average iteration time exceeding the first quartile's by more than `DRIFT_PCT` (default 20%), the
signature of a leak building under sustained load (drift alone is a loud warning, not a hard fail).

## Contract (what the workflow passes in)

The script is invoked as `bash web/e2e/suites/<suite>.sh` from the `web/e2e` working directory, with:

- **`PW_PROJECT`** — the Playwright project for the requested surface (`chromium` for `web`,
  `mobile-chromium` for `mobile-web`). Pass it through as `--project="$PW_PROJECT"`.
- **`DURATION_MINUTES`** — soak duration passthrough (may be empty; default sensibly).
- **`VUS`** — load virtual-users / concurrency passthrough (may be empty; default sensibly).

The backend, Postgres, and the Firebase Auth/Storage emulators are already up (same stack as `e2e.yml`).

## Native surfaces (`android` / `ios`) — these scripts are Playwright-only

The `golden.sh` / `soak.sh` / `load.sh` scripts here are **Playwright-only**: they run on the `web` and
`mobile-web` surfaces via `PW_PROJECT ∈ {chromium, mobile-chromium}` and have **no native branch**. So
for `suite=golden|soak|load` dispatched on a **native** surface, `test-suite.yml` does **not** call
these scripts:

- **`surface=android`** — the `android` job runs the **shared Maestro flow set**
  (`android/maestro/ci-run.sh`) as a smoke over that surface and logs a `::notice::` that the suite has
  no native variant. (`golden|soak|load` and a feature tag both run the same shared flow set — per-tag
  Maestro selection isn't wired.)
- **`surface=ios`** — the `ios` job (macOS Simulator, TM-353) mirrors the android job exactly: it runs
  the **shared iOS Simulator flow set** (`ios/maestro/ci-run.sh`) with the same `::notice::`. Until a
  WKWebView reCAPTCHA-bypass flag-injection path exists (the automated-smoke follow-up), that set is
  the tolerant "no iOS flows yet" path — proving Simulator boot + app launch + WebView load. See
  [`ios/maestro/README.md`](../../../ios/maestro/README.md).

If a **surface-specific** golden/soak/load script is ever wanted for a native surface, add it in the
respective `*/maestro/` dir and branch to it in that job — no change to the scripts in *this* directory.

## Evidence

Write screenshots/reports under `web/e2e/playwright-report` and/or `web/e2e/test-results` (Playwright's
defaults) so the workflow's evidence step picks them up and attaches them to the Jira ticket. Run Playwright
with `--screenshot=on` so there is always at least one screenshot per test.

Exit non-zero on suite failure so the dispatch reflects pass/fail.
