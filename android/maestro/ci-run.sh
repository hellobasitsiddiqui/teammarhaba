#!/usr/bin/env bash
# TM-318 — mobile-e2e emulator run: install APK, then run each Maestro flow from a CLEAN, signed-out
# state with the e2e reCAPTCHA-bypass flag injected.
#
# WHY A SCRIPT FILE: reactivecircus/android-emulator-runner runs an inline `script:` LINE-BY-LINE
# under `sh` (each line a separate `sh -c`), so multi-line `if/while` blocks break. Running the whole
# thing as one `bash android/maestro/ci-run.sh <apk>` invocation lets normal bash work.
#
# WHY PER-FLOW CLEAN + RE-INJECT: Maestro runs flows in one process; many flows sign in, so a later
# flow would start signed-in and couldn't cleanly reach the signed-out front door. And the e2e flag
# must survive (no `clearState`, which would wipe it and re-arm reCAPTCHA). So between flows we
# `pm clear` the app (clean auth) and RE-INJECT the flag over CDP — every flow starts identical:
# signed out, flag set. This is the state each flow is verified to pass from.
#
# Arg 1: path to the debug APK to install.
set -euo pipefail

APK="${1:?usage: ci-run.sh <apk-path>}"
APP_ID="app.teammarhaba.webview"
FLOW_DIR="android/maestro"
INJECTOR="$FLOW_DIR/inject-e2e-flag.mjs"

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

overall=0
for flow in "$FLOW_DIR"/*.yaml "$FLOW_DIR"/*.yml; do
  [ -e "$flow" ] || continue
  name="$(basename "$flow")"
  echo "──────────────────────────────────────────────────────────────────────"
  echo "▶ Flow: $name (clean state + re-inject)"
  adb shell pm clear "$APP_ID" >/dev/null 2>&1 || true   # wipe any prior session
  if ! inject_flag; then
    echo "::error::flag injection failed before $name"; overall=1; continue
  fi
  if maestro test "$flow" --format junit \
       --output "maestro-artifacts/report-${name%.*}.xml" \
       --debug-output "maestro-artifacts/debug-${name%.*}"; then
    echo "✔ $name passed"
  else
    echo "::error::flow failed: $name"; overall=1
  fi
done

exit "$overall"
