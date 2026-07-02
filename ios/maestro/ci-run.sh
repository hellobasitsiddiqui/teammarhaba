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
# THE reCAPTCHA-BYPASS FLAG — how iOS injects it (TM-354; was a gap under TM-353)
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# The Android SMS-login flow (login-sms.yaml) + dependents need a tm_e2e_phone_test=1 flag that the
# Android harness injects over the Chrome DevTools Protocol (android/maestro/inject-e2e-flag.mjs). That
# mechanism does NOT port to WKWebView (no adb; Safari webinspectord ≠ CDP). TM-354 solves it a
# different way that needs NOTHING from this script: the iOS shell
# (ios/App/App/TeamMarhabaViewController.swift) sets localStorage["tm_e2e_phone_test"]="1" from its
# `.atDocumentStart` WKUserScript — but ONLY when launched with the non-prod launch argument
# `-tmE2EPhoneTest`. The iOS Maestro flows declare that argument on every `launchApp`
# (`arguments: { tmE2EPhoneTest: "1" }`), which Maestro forwards to `simctl launch`, so each flow's
# WebView gets the flag before auth.js reads it — no CDP, no injector process here, and it re-applies
# on every relaunch. So unlike the Android script, this one does NOT inject the flag; the flows do.
#
# When there are no iOS flow files yet, this lane still proves the rung below the flows (Simulator boot
# + app install + launch + WebView load) and exits GREEN — the tolerant no-flows path (how
# mobile-e2e.yml merged before the Android flows existed). It never reaches across to android/maestro/.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# SIMULATOR-STATE PRIMING (TM-354) — what the plugin/gallery flows need in place
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# Some flows exercise native plugins that read device state the app can't set itself. We prime that
# ONCE up front (media + location persist on the DEVICE across app reinstall, so a per-flow fresh
# install doesn't wipe them), best-effort — a priming failure must never fail the run:
#   • addmedia  — seed one PNG into the Photos library so golden-path's GALLERY avatar step opens a
#                 non-empty picker (camera capture is out of scope; the gallery path needs a photo).
#   • location  — set a fixed coordinate so plugins.yaml's "Get my location" returns a coords fix.
# A push deep-link (`simctl push`, route /profile) is delivered just-in-time inside the plugin phase.
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

# ── Simulator-state priming (TM-354, all best-effort — never fail the run on a priming hiccup) ──────
# These write DEVICE state (not app data), so they persist across the per-flow app reinstall below.

# Seed one PNG into the Photos library so golden-path's GALLERY avatar step opens a non-empty picker.
# A minimal valid 1x1 PNG is decoded to a temp file and added with `simctl addmedia`.
seed_gallery_photo() {
  local png="${RUNNER_TEMP:-/tmp}/tm-seed-avatar.png"
  # 1x1 transparent PNG (same bytes the web avatar spec uses), base64-decoded to a file.
  echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC" \
    | base64 --decode > "$png" 2>/dev/null || return 0
  xcrun simctl addmedia "$UDID" "$png" >/dev/null 2>&1 \
    && echo "Seeded a photo into the Simulator library (for the gallery avatar step)." \
    || echo "::warning::could not seed a gallery photo (continuing; the gallery step is best-effort)."
}
seed_gallery_photo

# Set a fixed Simulator location so plugins.yaml's "Get my location" returns a coords fix (London-ish).
set_sim_location() {
  xcrun simctl location "$UDID" set 51.5074,-0.1278 >/dev/null 2>&1 \
    && echo "Set Simulator location to 51.5074,-0.1278 (for the geolocation smoke)." \
    || echo "::warning::could not set Simulator location (continuing; the geolocation step is best-effort)."
}
set_sim_location

# Deliver a local push with a deep-link route (TM-354 / reuses the T4 push shape). Best-effort: a
# headless Simulator's notification handling is non-deterministic, and this is a LOCAL simctl push, not
# a real-APNs round-trip (real APNs is out of Simulator scope). Called just before the plugin flow.
deliver_push_deeplink() {
  local payload="${RUNNER_TEMP:-/tmp}/tm-push.json"
  cat > "$payload" <<'JSON' 2>/dev/null || return 0
{ "aps": { "alert": { "title": "TeamMarhaba", "body": "Open your profile" }, "sound": "default" }, "route": "/profile" }
JSON
  xcrun simctl push "$UDID" "$APP_ID" "$payload" >/dev/null 2>&1 \
    && echo "Delivered a local push (route /profile) for the deep-link smoke." \
    || echo "::warning::could not deliver the local push (continuing; the deep-link step is best-effort)."
}

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
# here — the iOS-native flows below carry the iOS flag injection (see the header note, TM-354).
if [ ! -d "$FLOW_DIR" ] || [ -z "$(find "$FLOW_DIR" -maxdepth 1 -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null)" ]; then
  echo "::notice::No iOS Maestro flows under $FLOW_DIR yet — Simulator boot + app install + launch + WebView load proven, skipping flow run. (See $FLOW_DIR/README.md.)"
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
  # Fire the deep-link push just before the plugin flow so its (best-effort) navigation assertion has a
  # notification to act on. Only for plugins.yaml — the other flows don't exercise push.
  case "$name" in
    plugins.yaml) deliver_push_deeplink ;;
  esac
  if maestro test "$flow" --format junit \
       --output "maestro-artifacts/report-${name%.*}.xml" \
       --debug-output "maestro-artifacts/debug-${name%.*}"; then
    echo "✔ $name passed"
  else
    echo "::error::flow failed: $name"; overall=1
  fi
done

exit "$overall"
