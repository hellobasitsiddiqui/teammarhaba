# Maestro e2e flows — TeamMarhaba iOS Simulator (TM-353)

The iOS-Simulator sibling of [`android/maestro/`](../../android/maestro/README.md). Both drive the
**same native Capacitor WebView app** (`appId app.teammarhaba.webview`) loading the same hosted SPA at
`https://teammarhaba.web.app`; only the runner differs — `xcrun simctl` here vs `adb` there.

The runner is wired into the on-demand test-suite library
([`.github/workflows/test-suite.yml`](../../.github/workflows/test-suite.yml), TM-340) as the **`ios`
surface**: dispatching `surface=ios` boots an iOS Simulator on a `macos-latest` runner, builds the
Capacitor app for the `iphonesimulator` SDK (Debug, code-signing disabled), installs + launches it,
and hands off to [`ci-run.sh`](./ci-run.sh).

> **Ceiling: Simulator only.** No signing / provisioning / Apple account / TestFlight / physical
> device / real APNs. A Simulator destination needs none of that (`CODE_SIGNING_ALLOWED=NO`), which is
> why this lane carries **no signing secrets** — it is the compile-check shape, not the release job.

## Flow source — why this directory is (initially) flow-free

`ci-run.sh` runs whatever `*.yaml` / `*.yml` flows live **in this directory** and, when there are none
yet, exits **green** after proving the rung below the flows: **Simulator boot + app install + app
launch + WebView load** (a launch screenshot is captured as evidence). This mirrors exactly how
[`mobile-e2e.yml`](../../.github/workflows/mobile-e2e.yml) merged **before** the Android flows landed —
the tolerant "no flows yet" path.

It deliberately does **not** reach across to `android/maestro/*.yaml`, because those flows depend on a
mechanism that does not exist on iOS yet (below).

## Why the Android flows can't just be reused on iOS yet

The Android SMS-login flow (`android/maestro/login-sms.yaml`) — and the three flows that reuse it as a
subflow (`warm-restart`, `camera`, `biometric`, `permissions`) — depend on a **persisted
`localStorage["tm_e2e_phone_test"]` reCAPTCHA-bypass flag** that the Android harness injects over the
**Chrome DevTools Protocol** (`android/maestro/inject-e2e-flag.mjs`: `adb forward` a TCP port to the
WebView devtools socket, then `localStorage.setItem(…)`). See that README's *e2e-flag injection
contract* section.

That injector **does not port to WKWebView**:

- there is **no `adb`** on iOS, and
- the iOS WebView debugging protocol is **Safari `webinspectord`**, **not** CDP — so
  `inject-e2e-flag.mjs` cannot attach.

Without the flag, Firebase's phone-auth reCAPTCHA gate escalates to a visual puzzle in a scripted
WebView and the SMS flow stalls. So the SMS journey (and its dependents) **may not pass on iOS** until
a new **iOS flag-injection path** exists. That work is folded into the **automated-smoke ticket (T6)**;
this lane merges green on the no-flows path in the meantime, proving the shell + WebView are live.

When T6 lands an iOS flag-injection mechanism, iOS-ready flow files drop **into this directory** (or
the shared flows become injectable on both surfaces) and `ci-run.sh` runs them with **no workflow
change** — same as the Android side.

## Run locally against a Simulator

```bash
# from the repo root — build the app for the Simulator (Debug, no signing)
npm ci && npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/App/build \
  build CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=

# boot a Simulator and drive the lane exactly as CI does
UDID="$(xcrun simctl create tm-sim 'iPhone 15' \
  "$(xcrun simctl list runtimes | awk '/iOS/{print $NF}' | tail -n1)")"
xcrun simctl boot "$UDID"; xcrun simctl bootstatus "$UDID" -b
bash ios/maestro/ci-run.sh "$UDID" ios/App/build/Build/Products/Debug-iphonesimulator/App.app
```

> **Capacitor 8 uses Swift Package Manager, not CocoaPods** — the project is
> `ios/App/App.xcodeproj` with `ios/App/CapApp-SPM/Package.swift`; there is **no `App.xcworkspace`**
> and **no Podfile**, so there is no `pod install` step (plugin deps resolve via SPM during the
> build). See [`../README.md`](../README.md) and
> [`.github/workflows/ios-simulator.yml`](../../.github/workflows/ios-simulator.yml) (the compile
> gate, TM-349).

## Simulator ↔ emulator command mapping

`ci-run.sh` is a structural port of `android/maestro/ci-run.sh`; the per-flow clean-state loop maps
adb → simctl as:

| Purpose | Android (`adb`) | iOS (`xcrun simctl`) |
|---|---|---|
| Wipe app data (clean auth) | `adb shell pm clear <id>` | `terminate` + `uninstall` + re-`install` |
| Grant runtime permission | `adb` runtime grant / tap "Allow" | `simctl privacy <udid> grant <svc> <id>` |
| Launch the app | `adb shell am start` / `monkey` | `simctl launch <udid> <id>` |
| Screenshot | Maestro `takeScreenshot` | `simctl io <udid> screenshot` + Maestro |
| Target selection | `adb devices` | Maestro auto-targets the booted Simulator |

Maestro on iOS auto-targets the single booted Simulator; the only platform-relevant line in a shared
flow is its `appId: app.teammarhaba.webview` header, which is identical on iOS (the iOS bundle id is
`app.teammarhaba.webview` — no `.debug` suffix, unlike the Android debug variant).

## Evidence

`ci-run.sh` writes the launch screenshot, per-flow JUnit reports, and Maestro debug output under
`maestro-artifacts/` (plus a `NO_FLOWS_YET.txt` marker on the no-flows path) — the **same layout** the
Android job produces, so the workflow's existing `upload-artifact` + `test-suite-evidence.sh` steps
attach it to the Jira ticket with no change.
