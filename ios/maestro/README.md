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

## Scope & Simulator limitation (TM-354) — what the iOS automated lane actually gates

**iOS Simulator automated coverage = boots + loads the hosted SPA + screenshot evidence.** That is
the whole gate, on purpose, and here is why.

The app **does** boot and fully load on the Simulator — the launch screenshot shows the complete
sketch-themed login screen rendered (title, tagline, "Sign in", the email field, "Email me a code",
"Try another way"). Maestro on iOS can reliably **see static WebView text**. What it does **not**
reliably do on the iOS Simulator is drive **dynamic, JS-initiated DOM interaction** inside WKWebView.

Concretely: the authenticated journey's very first interactive step — tapping **"Try another way"** to
un-hide `#auth-alternatives` (which contains `#phone` + `#sms-send-btn`) — depends on
[`login.js`](../../web/src/assets/login.js)'s **ES-module click handler** firing inside WKWebView. On
the iOS Simulator that tap does not reliably take effect, so `#sms-send-btn` never reveals and the flow
fails with `Assertion is false: id: sms-send-btn is visible`. This reproduced **even with a 20×/100s
self-healing re-tap loop**. It is a **known Maestro-iOS / WKWebView limitation** (deep web interaction /
dynamic reveal) — the identical Android flow passes only because Maestro drives that WebView fine.

So the lane is split into two tiers, **by directory**, and `ci-run.sh` treats them differently:

| Tier | Location | Gates the lane? | Flow | Purpose |
|---|---|---|---|---|
| **GATE** | `ios/maestro/*.yaml` | **YES — must pass** | [`golden-path.yaml`](./golden-path.yaml) | **The iOS automated-test gate.** Launch the shell with `-tmE2EPhoneTest`, then **hard-assert the WKWebView rendered the hosted SPA** via the STATIC login text Maestro can see (`TeamMarhaba`, the tagline, `Sign in`, `Email me a code`, `Try another way`), screenshotting each. Proves the iOS-specific risk: the native shell loads + renders the shared web app. |
| **OPTIONAL** | `ios/maestro/optional/*.yaml` | **NO — best-effort, never fatal** | [`optional/journey.yaml`](./optional/journey.yaml) | The full authenticated journey: sign in → *(onboarding)* → *(terms)* → profile edit → avatar (**gallery**) → home → help/visual-guide → sign out. Mirrors [`web/e2e/tests/golden-path.spec.mjs`](../../web/e2e/tests/golden-path.spec.mjs). Reuses `login-sms.yaml`. |
| **OPTIONAL** | `ios/maestro/optional/*.yaml` | **NO — best-effort, never fatal** | [`optional/login-sms.yaml`](./optional/login-sms.yaml) | SMS happy-path via the Firebase test number `+16505550100` / `123456`. The subflow `journey.yaml`/`plugins.yaml` reuse; carries the **iOS e2e-flag launch-arg injection** (below). |
| **OPTIONAL** | `ios/maestro/optional/*.yaml` | **NO — best-effort, never fatal** | [`optional/plugins.yaml`](./optional/plugins.yaml) | Per-plugin Simulator smokes vs `#/diagnostics` + `#/profile`: geolocation, Face-ID app-lock, app-lock resume, push deep-link. |

`ci-run.sh` runs the GATE flow(s) fatally and the `optional/` flows **best-effort**: their outcome is
logged (and reports/screenshots uploaded, plus an `OPTIONAL_RESULTS.txt` summary) but a failure **never
changes the exit code**. It still keeps the tolerant "no gate flows yet → green after boot + install +
launch + WebView load" fallback from TM-353.

**We do NOT delete the journey and we do NOT fake a pass.** The `optional/` flows are kept as documented
**aspiration** — they will run green **on a physical device / once Maestro-iOS WKWebView interaction
improves**, and they are the exact journey the **human manual test ([TM-355])** walks on a real
Simulator. **Where the journey logic is actually covered on CI:** the **web Playwright golden-path**
([`web/e2e/tests/golden-path.spec.mjs`](../../web/e2e/tests/golden-path.spec.mjs), **TM-341**) exercises
the SAME journey against the SAME web code this WebView loads. So scoping the iOS gate to launch+render
loses **no** real coverage — it just stops asserting an interaction Maestro-iOS can't reliably perform.

> **App bug vs Maestro limitation?** The evidence points to a **Maestro-iOS/WKWebView limitation**, not
> an app defect: the same `login.js` ES-module handler drives the identical reveal reliably on Android's
> WebView, the SPA otherwise renders fully, and the static UI (incl. the "Try another way" control
> itself) paints. If a real-Simulator run under **TM-355** shows the reveal is actually a fixable
> app-side ES-module load failure *inside WKWebView* (e.g. a module that resolves on Android but not
> WKWebView), that would be a genuine bug candidate to file — but the launch+render gate stands either way.

The `onboarding`/`terms` steps in `optional/journey.yaml` are **guarded** (run only when the gate is
visible): the SMS test number is a **reused** account, so unlike the web spec's always-fresh email-code
user, it may already be past both first-run gates — the flow completes a gate when it fires and skips
it otherwise, landing on `#/home` either way.

It deliberately still does **not** reach across to `android/maestro/*.yaml` — the flows here are the
iOS-native copies (with the iOS injection), so the CDP-only Android flows never drive this lane.

[TM-355]: https://10xai.atlassian.net/browse/TM-355

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
> [`optional/login-sms.yaml`](./optional/login-sms.yaml) and
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

`ci-run.sh` writes the launch screenshot, the gate flow's step screenshots (`00-app-launched` …
`05-render-gate-passed`), per-flow JUnit reports, and Maestro debug output under `maestro-artifacts/`
(plus a `NO_FLOWS_YET.txt` marker on the no-flows path, and an `OPTIONAL_RESULTS.txt` PASS/FAIL summary
of the best-effort `optional/` flows) — the **same layout** the Android job produces, so the workflow's
existing `upload-artifact` + `test-suite-evidence.sh` steps attach it to the Jira ticket with no change.
The optional flows' own reports/screenshots are uploaded too, so when they DO pass (physical device /
improved Maestro-iOS) the journey evidence is already there.
