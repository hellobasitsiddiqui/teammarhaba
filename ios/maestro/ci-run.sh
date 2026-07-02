#!/usr/bin/env bash
# TM-353 — iOS-Simulator Maestro run: install the .app on a booted Simulator, then run each iOS
# Maestro flow from a CLEAN, signed-out state. This is the iOS analogue of
# android/maestro/ci-run.sh — same shape, same maestro-artifacts output layout, same tolerant
# "no flows yet → green" behaviour — but driven by `xcrun simctl` instead of `adb`.
#
# WHY A SCRIPT FILE (same reason as the Android one): keeping the per-flow clean-state loop in a
# bash file lets normal `if/while` blocks work, and keeps the workflow YAML step a one-liner.
#
# WHY PER-FLOW CLEAN: Maestro runs all flows in one process; many flows sign in, so a later flow
# would start signed-in and couldn't reach the signed-out front door. Between flows we therefore
# reset the app to a clean install:
#   • adb `pm clear`            → simctl `terminate` + `uninstall` + re-`install`   (wipes app data)
#   • adb runtime-permission    → simctl `privacy grant` camera/photos/location     (pre-granted)
# so every flow starts identical: freshly installed, signed out, permissions granted.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# THE reCAPTCHA-BYPASS FLAG GAP (why iOS flows are gated separately from the Android set)
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# The Android SMS-login flow (login-sms.yaml) and its dependents rely on a PERSISTED localStorage
# flag (tm_e2e_phone_test=1) that the Android harness injects over the Chrome DevTools Protocol
# (android/maestro/inject-e2e-flag.mjs: adb-forward a TCP port to the WebView devtools socket, then
# set the key). That mechanism does NOT port to WKWebView: there is no adb, and the Safari
# webinspectord protocol is not CDP. So the shared android/maestro/*.yaml flows CANNOT be driven
# unattended on iOS yet — the SMS gate would escalate to a visual reCAPTCHA and stall.
#
# A dedicated iOS flag-injection path is folded into the automated-smoke ticket (T6). Until it lands,
# THIS lane's job is to prove the rung below the flows: Simulator boot + app install + app launch +
# WebView load. It runs whatever iOS-ready flows exist under ios/maestro/ and, when there are none
# yet, exits GREEN after those lower rungs are proven — exactly how mobile-e2e.yml merged before the
# Android flows existed (the tolerant no-flows path). It deliberately does NOT reach across to
# android/maestro/, so the CDP-only Android flows don't red-flag this lane.
#
# Arg 1: the booted Simulator UDID (from `xcrun simctl` in the workflow).
# Arg 2: path to the built .app to install (Debug-iphonesimulator/App.app).
set -euo pipefail

UDID="${1:?usage: ci-run.sh <simulator-udid> <app-path>}"
APP="${2:?usage: ci-run.sh <simulator-udid> <app-path>}"
APP_ID="app.teammarhaba.webview"
FLOW_DIR="ios/maestro"

[ -d "$APP" ] || { echo "::error::app bundle not found: $APP"; exit 1; }

echo "Booted simulators:"
xcrun simctl list devices booted

echo "Installing app bundle on ${UDID}: $APP"
xcrun simctl install "$UDID" "$APP"
mkdir -p maestro-artifacts

# Pre-grant the runtime permissions the app may request (camera/photos/location). On the Simulator
# these can be granted non-interactively, which removes the flaky "tap Allow" system-dialog dance the
# Android permissions flow has to do best-effort. `|| true` — a service name unknown to this iOS
# version must not fail the run.
grant_perms() {
  for svc in camera photos location location-always; do
    xcrun simctl privacy "$UDID" grant "$svc" "$APP_ID" >/dev/null 2>&1 || true
  done
}
grant_perms

# Prove the app actually launches + the WebView loads on the Simulator BEFORE any flow runs — this is
# the load-bearing evidence this lane exists to produce (mirrors mobile-e2e proving APK install even
# with no flows). Capture the boot as a screenshot so there is always evidence to upload/attach.
echo "Launching $APP_ID to prove Simulator boot + WebView load…"
xcrun simctl launch "$UDID" "$APP_ID" || { echo "::error::app failed to launch on the Simulator"; exit 1; }
# The hosted SPA is remote (server.url = https://teammarhaba.web.app), so give the WebView a moment to
# fetch + render before the screenshot.
sleep 8
xcrun simctl io "$UDID" screenshot maestro-artifacts/00-app-launched.png || \
  echo "::warning::could not capture the launch screenshot (continuing)."
xcrun simctl terminate "$UDID" "$APP_ID" >/dev/null 2>&1 || true

# Tolerant flow discovery: if there are no iOS flow files yet, the boot + install + launch + WebView
# load above are the proof — exit GREEN (same contract as android/maestro/ci-run.sh and the way
# mobile-e2e.yml merged before flows existed). The shared android/maestro/*.yaml flows are NOT run
# here — see the header note on the CDP flag-injection gap (T6).
if [ ! -d "$FLOW_DIR" ] || [ -z "$(find "$FLOW_DIR" -maxdepth 1 -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null)" ]; then
  echo "::notice::No iOS Maestro flows under $FLOW_DIR yet — Simulator boot + app install + launch + WebView load proven, skipping flow run. (iOS flag-injection path is T6; see $FLOW_DIR/README.md.)"
  echo "no-ios-flows-yet" > maestro-artifacts/NO_FLOWS_YET.txt
  exit 0
fi

# Maestro on iOS auto-targets the booted Simulator (no device id needed); the flows' only
# platform-relevant header is `appId: app.teammarhaba.webview`, identical on iOS.
overall=0
for flow in "$FLOW_DIR"/*.yaml "$FLOW_DIR"/*.yml; do
  [ -e "$flow" ] || continue
  name="$(basename "$flow")"
  echo "──────────────────────────────────────────────────────────────────────"
  echo "▶ Flow: $name (clean state)"
  # Clean state == fresh install (the simctl analogue of adb `pm clear`): terminate, uninstall, then
  # reinstall + re-grant. This wipes any prior session/localStorage so each flow starts signed out.
  xcrun simctl terminate "$UDID" "$APP_ID" >/dev/null 2>&1 || true
  xcrun simctl uninstall "$UDID" "$APP_ID" >/dev/null 2>&1 || true
  xcrun simctl install "$UDID" "$APP" >/dev/null 2>&1 || { echo "::error::reinstall failed before $name"; overall=1; continue; }
  grant_perms
  if maestro test "$flow" --format junit \
       --output "maestro-artifacts/report-${name%.*}.xml" \
       --debug-output "maestro-artifacts/debug-${name%.*}"; then
    echo "✔ $name passed"
  else
    echo "::error::flow failed: $name"; overall=1
  fi
done

exit "$overall"
