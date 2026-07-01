#!/usr/bin/env bash
# Golden-path suite (TM-341) — the handoff script TM-340's test-suite.yml dispatches for
# `suite=golden`. Invoked as `bash web/e2e/suites/golden.sh` from the `web/e2e` working directory,
# with the stack (backend + Postgres + Firebase Auth/Storage emulators) already up.
#
# Contract (see suites/README.md): PW_PROJECT is the Playwright project for the requested surface
# (`chromium` for web, `mobile-chromium` for mobile-web). We run ONLY the @golden journey on that
# project, with screenshots forced on so there's always per-step evidence to attach to the ticket.
# Exit non-zero on failure so the dispatch reflects pass/fail.
set -euo pipefail

# Default to the desktop project if the workflow didn't pass one (e.g. a bare local invocation).
PROJECT="${PW_PROJECT:-chromium}"

echo "Running the @golden journey on project ${PROJECT}"
exec npx playwright test --project="${PROJECT}" --grep "@golden"
