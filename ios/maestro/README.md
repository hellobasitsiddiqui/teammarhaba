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

## Flows (TM-354)

`ci-run.sh` runs whatever `*.yaml` / `*.yml` flows live **in this directory** (and still keeps the
tolerant "no flows yet → green after boot + install + launch + WebView load" path from TM-353 as a
fallback). The flows here:

| Flow | Purpose |
|---|---|
| [`golden-path.yaml`](./golden-path.yaml) | **The iOS automated-test gate.** The shared golden journey on the Simulator: sign in → *(onboarding)* → *(terms)* → profile edit → avatar (**gallery** path) → home → help/visual-guide → sign out. Mirrors [`web/e2e/tests/golden-path.spec.mjs`](../../web/e2e/tests/golden-path.spec.mjs). Screenshots at every step. |
| [`login-sms.yaml`](./login-sms.yaml) | SMS happy-path via the Firebase test number `+16505550100` / `123456`. The subflow the others reuse; carries the **iOS e2e-flag launch-arg injection** (below). |
| [`plugins.yaml`](./plugins.yaml) | Best-effort per-plugin Simulator smokes vs `#/diagnostics` + `#/profile`: geolocation, Face-ID app-lock, app-lock resume, push deep-link. |

The `onboarding`/`terms` steps in `golden-path.yaml` are **guarded** (run only when the gate is
visible): the SMS test number is a **reused** account, so unlike the web spec's always-fresh
email-code user, it may already be past both first-run gates. The flow completes a gate when it fires
and skips it otherwise — landing on `#/home` either way.

It deliberately still does **not** reach across to `android/maestro/*.yaml` — the flows here are the
iOS-native copies (with the iOS injection), so the CDP-only Android flows never drive this lane.

## The iOS reCAPTCHA-bypass flag injection (TM-354) — how it replaces the Android CDP path

The Android SMS flow relies on a **persisted `localStorage["tm_e2e_phone_test"]` reCAPTCHA-bypass
flag** injected over the **Chrome DevTools Protocol**
([`android/maestro/inject-e2e-flag.mjs`](../../android/maestro/inject-e2e-flag.mjs): `adb forward` a
TCP port to the WebView devtools socket, then `localStorage.setItem(…)`). That injector **does not
port to WKWebView** — there is **no `adb`** on iOS, and the iOS WebView debugger is Safari
**`webinspectord`**, **not** CDP.

**The iOS mechanism instead runs entirely inside the shell — no external injector, no
`ios-webkit-debug-proxy`/webinspectord.** The Capacitor host view controller
([`ios/App/App/TeamMarhabaViewController.swift`](../../ios/App/App/TeamMarhabaViewController.swift))
already injects a `WKUserScript` at **`.atDocumentStart`** (before any page script — so before
`web/src/assets/auth.js` module-load reads the flag). TM-354 extends that script to **also** set
`localStorage["tm_e2e_phone_test"]="1"` — but **only when the process was launched with the non-prod
launch argument `-tmE2EPhoneTest`** (or env `TM_E2E_PHONE_TEST=1`), read via `ProcessInfo`.

The flows pass that argument on **every** `launchApp`:

```yaml
- launchApp:
    arguments:
      tmE2EPhoneTest: "1"   # Maestro → `simctl launch … -tmE2EPhoneTest 1`; ProcessInfo sees "-tmE2EPhoneTest"
```

So the flag is set **at document-start on every launch** — no CDP, no reload dance, and it survives
Maestro's relaunches automatically (the arg is re-passed each launch, so there is **no "must not
`clearState`" contract** on iOS, unlike the Android side). It is emitted **nowhere in production**: the
App Store binary is never launched with that arg, and even if it somehow were, `phone-e2e.js`'s
second **context-safe** gate (native shell / Auth emulator) still holds — exactly why that gate exists.
This mirrors the Android debug-build gate (WebView debugging on for debug, off for release).

> Because this reads a **launch-time** signal rather than persisting state the harness sets, it is
> strictly cleaner than the Android CDP approach: the whole injector process, the devtools-socket
> discovery, and the `clearState` contract all disappear. See the header of
> [`login-sms.yaml`](./login-sms.yaml) and
> [`TeamMarhabaViewController.swift`](../../ios/App/App/TeamMarhabaViewController.swift).

> **Deploy caveat (same as Android, TM-318):** the app loads the **hosted prod SPA**, so the flag is
> only honoured once the `auth.js`/`phone-e2e.js` logic is deployed — which it already is (Android uses
> the same code path). No new web deploy is needed for iOS to honour the flag.

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
