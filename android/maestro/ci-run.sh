#!/usr/bin/env bash
# TM-318 / TM-399 — mobile-e2e emulator run: install APK, then run each Maestro flow from a CLEAN,
# signed-out state with the e2e reCAPTCHA-bypass flag injected.
#
# WHY A SCRIPT FILE: reactivecircus/android-emulator-runner runs an inline `script:` LINE-BY-LINE
# under `sh` (each line a separate `sh -c`), so multi-line `if/while` blocks break. Running the whole
# thing as one `bash android/maestro/ci-run.sh <apk> [suite]` invocation lets normal bash work.
#
# WHY PER-FLOW CLEAN + RE-INJECT: Maestro runs flows in one process; many flows sign in, so a later
# flow would start signed-in and couldn't cleanly reach the signed-out front door. And the e2e flag
# must survive (no `clearState`, which would wipe it and re-arm reCAPTCHA). So between flows we
# `pm clear` the app (clean auth) and RE-INJECT the flag over CDP — every flow starts identical:
# signed out, flag set. This is the state each flow is verified to pass from.
#
# TM-399 additions:
#   • SUITE ARG ($2, default "all") — per-suite flow selection so `test-suite.yml -f suite=events`
#     runs ONLY the Events journey (events.yaml). The default/all/golden/soak set is the shared device
#     smoke (login-sms, warm-restart, camera, biometric, permissions) EXACTLY as before — events.yaml
#     is suite-scoped (it needs a seeded event) and is deliberately kept OUT of the default set so the
#     nightly/all run doesn't regress.
#   • SCREENSHOT HARVEST (TM-371) — Maestro writes `takeScreenshot` to ~/.maestro/tests/<ts>/, NOT into
#     maestro-artifacts/. The android lane never harvested them (unlike ios/maestro/ci-run.sh), so the
#     Jira evidence zip (built from maestro-artifacts only) lost every per-step shot. We now harvest
#     each flow's PNGs into maestro-artifacts/screenshots-<flow>/ after it runs.
#   • REMINDER/LIFECYCLE PUSH RECEIPT (best-effort, non-gating) — after the Events journey, drive the
#     TM-368 real-FCM method (opt into push + read the device token over CDP, then dumpsys + a tray
#     screenshot). NEVER changes the run's pass/fail (emulator FCM delivery + the admin/wall-clock
#     trigger are environment-provided).
#
# Arg 1: path to the debug APK to install.  Arg 2: suite (default "all").
set -euo pipefail

APK="${1:?usage: ci-run.sh <apk-path> [suite]}"
SUITE="${2:-all}"
APP_ID="app.teammarhaba.webview"
FLOW_DIR="android/maestro"
INJECTOR="$FLOW_DIR/inject-e2e-flag.mjs"
# The default heading events.yaml browses/RSVPs (overridable via the EVENT_HEADING env). Kept in sync
# with the flow's own env default so the seed notice names the right event.
EVENT_HEADING="${EVENT_HEADING:-TeamMarhaba e2e coffee morning}"

adb devices
echo "Installing debug APK: $APK"
adb install -r -t "$APK"
mkdir -p maestro-artifacts

# Tolerant flow discovery: nothing to do if there are no flow files yet.
if [ ! -d "$FLOW_DIR" ] || [ -z "$(find "$FLOW_DIR" -maxdepth 1 -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null)" ]; then
  echo "::notice::No Maestro flows under $FLOW_DIR yet — emulator booted + APK installed OK, skipping."
  echo "no-flows-yet" > maestro-artifacts/NO_FLOWS_YET.txt
  exit 0
fi

# ── Select the flow set for this SUITE ───────────────────────────────────────────────────────────
# Suite-scoped flows are NOT part of the default shared smoke set (they carry their own data/trigger
# preconditions); each runs only when its suite is explicitly selected.
FLOWS=()
case "$SUITE" in
  events)
    if [ ! -e "$FLOW_DIR/events.yaml" ]; then
      echo "::error::suite=events but $FLOW_DIR/events.yaml is missing."; exit 1
    fi
    FLOWS=("$FLOW_DIR/events.yaml")
    echo "::notice::suite=events → running the Events Maestro journey (events.yaml) on the android surface."
    echo "::notice::events needs a PUBLIC upcoming event titled '${EVENT_HEADING}' to browse/RSVP. Set EVENTS_SEED_CMD to seed it, or pre-seed one via the admin Events console/API (see android/maestro/README.md → 'Events data precondition')."
    if [ -n "${EVENTS_SEED_CMD:-}" ]; then
      echo "  seeding via EVENTS_SEED_CMD…"
      bash -c "$EVENTS_SEED_CMD" || echo "::warning::EVENTS_SEED_CMD failed — events.yaml will fail LOUD at the browse assertion (the honest contract)."
    fi
    ;;
  *)
    # Default / all / golden / soak / unknown → the shared device smoke set, EXCLUDING suite-scoped
    # flows. Preserves the pre-TM-399 nightly/all behaviour exactly.
    echo "::notice::suite='${SUITE}' → running the shared android Maestro smoke set (per-tag selection wired for 'events' only)."
    for f in "$FLOW_DIR"/*.yaml "$FLOW_DIR"/*.yml; do
      [ -e "$f" ] || continue
      case "$(basename "$f")" in
        events.yaml) continue ;;  # suite-scoped (suite=events); needs a seeded event
      esac
      FLOWS+=("$f")
    done
    ;;
esac

# Set localStorage["tm_e2e_phone_test"]="1" in the app WebView over CDP (see inject-e2e-flag.mjs).
inject_flag() {
  echo "Launching $APP_ID for CDP injection…"
  adb shell am start -n "$APP_ID/.MainActivity" >/dev/null 2>&1 || true  # am start is reliable; monkey is not after pm clear
  sleep 2
  local socket="" i=0
  while [ "$i" -lt 30 ]; do
    socket="$(adb shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | head -n1 || true)"
    [ -n "$socket" ] && break
    i=$((i + 1)); sleep 2
  done
  if [ -z "$socket" ]; then
    echo "::error::no WebView devtools socket — is this a DEBUG build?"; return 1
  fi
  adb forward tcp:9222 "localabstract:$socket" >/dev/null
  local rc=0
  CDP_PORT=9222 node "$INJECTOR" || rc=$?
  adb forward --remove tcp:9222 >/dev/null 2>&1 || true
  return $rc
}

# TM-371: harvest EVERY screenshot a flow produced into the uploaded artifact dir, so the Jira evidence
# zip (built from maestro-artifacts only) carries the full per-step set — the android lane never did
# this (only the GH artifact's ~/.maestro/tests path caught them). Mirrors ios/maestro/ci-run.sh.
# Never let harvesting change a flow's pass/fail.
harvest_screenshots() {
  local name="$1"
  local shots="maestro-artifacts/screenshots-${name%.*}"; mkdir -p "$shots"
  local latest; latest="$(ls -1dt "$HOME"/.maestro/tests/*/ 2>/dev/null | head -1)"
  [ -n "$latest" ] && find "$latest" -name '*.png' -exec cp -f {} "$shots/" \; 2>/dev/null || true
  echo "  harvested $(ls -1 "$shots"/*.png 2>/dev/null | wc -l | tr -d ' ') screenshot(s) for $name"
}

# Best-effort, NON-GATING reminder/lifecycle push-receipt check (TM-368 method). Runs against the
# STILL-signed-in session left by events.yaml (no pm clear since). Opts into push + reads the device's
# FCM token over CDP (push-receipt.mjs), triggers a send if the environment provides one, then captures
# the notification-service state + a tray screenshot as evidence. Every step tolerates failure.
verify_reminder_push() {
  echo "── Events reminder/lifecycle PUSH RECEIPT (best-effort, TM-368 method; non-gating) ──"
  adb shell pm grant "$APP_ID" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
  # Re-forward CDP to the live WebView and run the receiver setup (opt-in + token read).
  local socket="" i=0
  while [ "$i" -lt 15 ]; do
    socket="$(adb shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | head -n1 || true)"
    [ -n "$socket" ] && break
    i=$((i + 1)); sleep 2
  done
  if [ -n "$socket" ]; then
    adb forward tcp:9223 "localabstract:$socket" >/dev/null 2>&1 || true
    CDP_PORT=9223 node "$FLOW_DIR/push-receipt.mjs" || true
    adb forward --remove tcp:9223 >/dev/null 2>&1 || true
  else
    echo "::notice::push receipt: no WebView devtools socket (needs the DEBUG build) — skipped opt-in/token read."
  fi
  # Trigger: a real reminder/lifecycle push needs an admin send (POST /admin/events/{id}/cancel or
  # /admin/users/{id}/test-push) or the wall-clock reminder scheduler — both environment-provided. Run
  # the orchestrator-supplied trigger if present; otherwise capture whatever is already in the tray.
  if [ -n "${EVENTS_PUSH_TRIGGER_CMD:-}" ]; then
    echo "  triggering push via EVENTS_PUSH_TRIGGER_CMD…"; bash -c "$EVENTS_PUSH_TRIGGER_CMD" || true; sleep 8
  else
    echo "::notice::push receipt: no EVENTS_PUSH_TRIGGER_CMD set — capturing the current tray only. Supply an admin reminder/lifecycle/test-push trigger to complete the TM-368 round-trip."
  fi
  # Evidence: notification-service dump + a tray screenshot into the artifact (harvested + uploaded).
  adb shell dumpsys notification --noredact > "maestro-artifacts/push-dumpsys.txt" 2>/dev/null || true
  adb shell cmd statusbar expand-notifications >/dev/null 2>&1 || adb shell service call statusbar 1 >/dev/null 2>&1 || true
  sleep 2
  adb exec-out screencap -p > "maestro-artifacts/push-tray.png" 2>/dev/null || true
  adb shell cmd statusbar collapse >/dev/null 2>&1 || adb shell service call statusbar 2 >/dev/null 2>&1 || true
  if grep -qiE "teammarhaba|reminder|going|event" "maestro-artifacts/push-dumpsys.txt" 2>/dev/null; then
    echo "  ✔ a TeamMarhaba-class notification is present in dumpsys (evidence: push-dumpsys.txt / push-tray.png)."
  else
    echo "::notice::push receipt: no TeamMarhaba notification observed — see push-dumpsys.txt / push-tray.png (best-effort, non-gating)."
  fi
}

overall=0
for flow in "${FLOWS[@]}"; do
  [ -e "$flow" ] || continue
  name="$(basename "$flow")"
  echo "──────────────────────────────────────────────────────────────────────"
  echo "▶ Flow: $name (clean state + re-inject)"
  adb shell pm clear "$APP_ID" >/dev/null 2>&1 || true   # wipe any prior session
  if ! inject_flag; then
    echo "::error::flag injection failed before $name"; overall=1; continue
  fi
  # Forward EVENT_HEADING into the flow when set, so a run can target a bespoke seeded event.
  extra=()
  if [ "$name" = "events.yaml" ] && [ -n "${EVENT_HEADING:-}" ]; then
    extra=(-e "EVENT_HEADING=${EVENT_HEADING}")
  fi
  if maestro test "$flow" "${extra[@]}" --format junit \
       --output "maestro-artifacts/report-${name%.*}.xml" \
       --debug-output "maestro-artifacts/debug-${name%.*}"; then
    echo "✔ $name passed"
  else
    echo "::error::flow failed: $name"; overall=1
  fi
  harvest_screenshots "$name"
  # After the Events journey (session still signed in), run the best-effort push-receipt check.
  if [ "$name" = "events.yaml" ]; then
    verify_reminder_push || true
  fi
done

exit "$overall"
