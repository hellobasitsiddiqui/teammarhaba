#!/usr/bin/env bash
# Soak / endurance suite (TM-342) — the handoff script TM-340's test-suite.yml dispatches for
# `suite=soak`. Invoked as `bash web/e2e/suites/soak.sh` from the `web/e2e` working directory, with
# the stack (backend + Postgres + Firebase Auth/Storage emulators) already up.
#
# WHY A SOAK: a single golden-path pass proves the product works once. A soak LOOPS that same
# happy-path journey back-to-back for a configurable wall-clock window to surface the things one
# pass can't — resource leaks, gradual degradation, and intermittent flakiness that only shows up
# over many runs. Each iteration is the exact @golden journey (see golden.sh), on the same project.
#
# Contract (see suites/README.md):
#   PW_PROJECT       — Playwright project for the requested surface (chromium / mobile-chromium).
#   DURATION_MINUTES — how long to keep looping, in minutes (may be empty; defaults to 10).
#
# Per iteration we record pass/fail + wall-clock seconds. At the end we emit a summary
# (iterations, pass/fail counts, min/max/avg iteration seconds) and FLAG a problem when either:
#   (a) any iteration failed, or
#   (b) latency drifted UP over the run — the average of the last quartile of iterations exceeds
#       the average of the first quartile by more than DRIFT_PCT (default 20%), which is the
#       signature of a leak/degradation building up under sustained load.
# Exit non-zero if any iteration failed (drift alone is a loud WARNING, not a hard fail — it's a
# heuristic and we don't want a noisy metric to red-flag an otherwise all-green endurance run).
set -uo pipefail

PROJECT="${PW_PROJECT:-chromium}"

# Duration: default to 10 minutes; ignore a blank/non-numeric passthrough.
DURATION_MINUTES="${DURATION_MINUTES:-}"
if ! [[ "$DURATION_MINUTES" =~ ^[0-9]+$ ]] || [ "$DURATION_MINUTES" -lt 1 ]; then
  DURATION_MINUTES=10
fi

# Upward-drift threshold (percent). Last-quartile avg > first-quartile avg by this much ⇒ WARN.
DRIFT_PCT="${DRIFT_PCT:-20}"

DURATION_SECONDS=$(( DURATION_MINUTES * 60 ))
START_EPOCH=$(date +%s)
DEADLINE=$(( START_EPOCH + DURATION_SECONDS ))

echo "=================================================================="
echo "SOAK / endurance — looping the @golden journey on project ${PROJECT}"
echo "  duration: ${DURATION_MINUTES} min (${DURATION_SECONDS}s)  |  drift threshold: ${DRIFT_PCT}%"
echo "  each iteration: npx playwright test --grep @golden --project=${PROJECT}"
echo "=================================================================="

DURATIONS=()   # per-iteration wall-clock seconds (all iterations)
PASS=0
FAIL=0
ITER=0

while :; do
  NOW=$(date +%s)
  if [ "$NOW" -ge "$DEADLINE" ]; then
    break
  fi
  ITER=$(( ITER + 1 ))
  REMAINING=$(( DEADLINE - NOW ))
  echo ""
  echo "------ iteration ${ITER}  (elapsed $(( NOW - START_EPOCH ))s / ${DURATION_SECONDS}s, ${REMAINING}s left) ------"

  ITER_START=$(date +%s)
  # The Playwright config already forces screenshots on for every test (playwright.config.mjs:
  # `screenshot: "on"`), so each iteration always yields per-step evidence for the workflow to
  # attach — no CLI flag needed (and `--screenshot` isn't a valid CLI option in PW 1.49).
  if npx playwright test --project="${PROJECT}" --grep "@golden"; then
    ITER_RESULT="PASS"
    PASS=$(( PASS + 1 ))
  else
    ITER_RESULT="FAIL"
    FAIL=$(( FAIL + 1 ))
  fi
  ITER_END=$(date +%s)
  ITER_SECONDS=$(( ITER_END - ITER_START ))
  DURATIONS+=( "$ITER_SECONDS" )
  echo "------ iteration ${ITER}: ${ITER_RESULT} in ${ITER_SECONDS}s ------"
done

echo ""
echo "=================================================================="
echo "SOAK SUMMARY"
echo "=================================================================="

if [ "$ITER" -eq 0 ]; then
  # Even a 1-minute soak should complete at least one golden pass. Zero iterations means the very
  # first run never even started — treat as a failure.
  echo "::error::soak ran 0 iterations in ${DURATION_MINUTES} min — the journey never started."
  exit 1
fi

# min / max / avg over all iterations.
MIN=${DURATIONS[0]}
MAX=${DURATIONS[0]}
SUM=0
for d in "${DURATIONS[@]}"; do
  [ "$d" -lt "$MIN" ] && MIN=$d
  [ "$d" -gt "$MAX" ] && MAX=$d
  SUM=$(( SUM + d ))
done
# Integer avg with one-decimal precision (avg = SUM*10/ITER, formatted).
AVG_X10=$(( SUM * 10 / ITER ))
AVG="${AVG_X10:0:${#AVG_X10}-1}.${AVG_X10: -1}"
[ "${#AVG_X10}" -le 1 ] && AVG="0.${AVG_X10}"

echo "  iterations run : ${ITER}"
echo "  passed         : ${PASS}"
echo "  failed         : ${FAIL}"
echo "  iteration secs : min=${MIN}  max=${MAX}  avg=${AVG}"

# ── Upward-drift detection ────────────────────────────────────────────────────────────────────
# Compare the average of the FIRST quartile of iterations to the average of the LAST quartile. A
# meaningfully higher last-quartile average means each loop is getting slower as the run wears on —
# the classic fingerprint of a leak or accumulating degradation. Needs >=4 iterations to be
# meaningful; below that we can't split into quartiles, so we just note it.
DRIFT_FLAGGED=0
if [ "$ITER" -ge 4 ]; then
  Q=$(( ITER / 4 ))            # quartile size (>=1 when ITER>=4)
  # first-quartile avg (x10)
  fsum=0
  for ((i=0; i<Q; i++)); do fsum=$(( fsum + DURATIONS[i] )); done
  first_x10=$(( fsum * 10 / Q ))
  # last-quartile avg (x10)
  lsum=0
  for ((i=ITER-Q; i<ITER; i++)); do lsum=$(( lsum + DURATIONS[i] )); done
  last_x10=$(( lsum * 10 / Q ))

  fmt() { local v=$1; if [ "${#v}" -le 1 ]; then echo "0.${v}"; else echo "${v:0:${#v}-1}.${v: -1}"; fi; }
  echo "  latency drift  : first-quartile avg=$(fmt $first_x10)s  last-quartile avg=$(fmt $last_x10)s  (n=${Q} each)"

  # threshold = first_x10 * (100 + DRIFT_PCT) / 100
  threshold_x10=$(( first_x10 * ( 100 + DRIFT_PCT ) / 100 ))
  if [ "$first_x10" -gt 0 ] && [ "$last_x10" -gt "$threshold_x10" ]; then
    DRIFT_FLAGGED=1
    echo "::warning::UPWARD LATENCY DRIFT — last-quartile avg ($(fmt $last_x10)s) exceeds first-quartile avg ($(fmt $first_x10)s) by more than ${DRIFT_PCT}%. Possible leak / degradation under sustained load."
  else
    echo "  drift check    : OK (last quartile within ${DRIFT_PCT}% of first)"
  fi
else
  echo "  latency drift  : skipped (need >=4 iterations, ran ${ITER})"
fi

echo "=================================================================="

# Exit policy: any failed iteration ⇒ non-zero (hard fail). Drift is a loud warning only.
if [ "$FAIL" -gt 0 ]; then
  echo "::error::soak FAILED — ${FAIL}/${ITER} iteration(s) failed."
  exit 1
fi

if [ "$DRIFT_FLAGGED" -eq 1 ]; then
  echo "soak PASSED (all ${ITER} iterations green) but flagged upward latency drift — investigate."
else
  echo "soak PASSED — all ${ITER} iterations green, no significant latency drift."
fi
exit 0
