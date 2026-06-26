#!/usr/bin/env bash
# TM-318: mobile-e2e emulator run (install APK -> inject e2e flag over CDP -> run Maestro flows).
#
# WHY THIS IS A SCRIPT FILE (not an inline `script:` in mobile-e2e.yml): the
# reactivecircus/android-emulator-runner action executes the inline `script:` LINE-BY-LINE under
# `sh` (each line a separate `sh -c`), so multi-line shell blocks (`if … then … fi`, `while`) break
# with "Syntax error: end of file unexpected (expecting fi)". Running the whole thing as one
# `bash android/maestro/ci-run.sh <apk>` invocation lets normal multi-line bash work.
#
# Arg 1: path to the debug APK to install.
set -euo pipefail

APK="${1:?usage: ci-run.sh <apk-path>}"
APP_ID="app.teammarhaba.webview"

adb devices
echo "Installing debug APK: $APK"
adb install -r -t "$APK"

mkdir -p maestro-artifacts

# Tolerant flow discovery: if android/maestro/ is missing or has no flow files, log a clear notice
# and pass (lets the workflow merge before flows are authored).
if [ ! -d android/maestro ] || [ -z "$(find android/maestro -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null)" ]; then
  echo "::notice::No Maestro flows found under android/maestro/ yet. Emulator booted + debug APK installed OK — skipping flow execution, not failing."
  echo "no-flows-yet" > maestro-artifacts/NO_FLOWS_YET.txt
  exit 0
fi

# ── TM-318: persist the phone-auth e2e flag in the app's WebView over CDP ──────────────────────────
# Set localStorage["tm_e2e_phone_test"]="1" INSIDE the WebView so auth.js disables reCAPTCHA
# app-verification for the Firebase test number (see README "e2e-flag injection contract"). A
# PERSISTED key is used because it survives the app relaunches Maestro performs between flows.
echo "Launching $APP_ID to bring up its WebView for CDP injection…"
adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true

# Poll for the WebView devtools unix socket (webview_devtools_remote_<pid>) to appear.
DEVTOOLS_SOCKET=""
i=0
while [ "$i" -lt 30 ]; do
  DEVTOOLS_SOCKET="$(adb shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | head -n1 || true)"
  if [ -n "$DEVTOOLS_SOCKET" ]; then
    break
  fi
  i=$((i + 1))
  sleep 2
done

if [ -z "$DEVTOOLS_SOCKET" ]; then
  echo "::error::TM-318: no WebView devtools socket found — cannot inject the e2e flag. Is this a DEBUG build (WebView debugging on)?"
  exit 1
fi
echo "Found WebView devtools socket: $DEVTOOLS_SOCKET"

# Forward a local TCP port to the WebView's abstract unix socket, then run the CDP injector.
adb forward tcp:9222 "localabstract:$DEVTOOLS_SOCKET"
if CDP_PORT=9222 node android/maestro/inject-e2e-flag.mjs; then
  INJECT_RC=0
else
  INJECT_RC=$?
fi
adb forward --remove tcp:9222 || true
if [ "$INJECT_RC" -ne 0 ]; then
  echo "::error::TM-318: e2e-flag CDP injection failed (rc=$INJECT_RC); the SMS flow would hit the reCAPTCHA gate."
  exit "$INJECT_RC"
fi

echo "Running Maestro flows from android/maestro/ …"
# --format junit + a test-output dir give machine-readable results; Maestro also writes per-flow
# screenshots/video into the debug output dir we point it at.
maestro test android/maestro/ \
  --format junit \
  --output maestro-artifacts/maestro-report.xml \
  --debug-output maestro-artifacts/debug
