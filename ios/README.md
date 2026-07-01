# TeamMarhaba iOS (Capacitor hybrid, **Simulator only**) — TM-348 / TM-349

A **Capacitor** iOS host that wraps the hosted TeamMarhaba web UI
(`https://teammarhaba.web.app`) in a `WKWebView`. It is the iOS analogue of [`../android/README.md`](../android/README.md) — same load model, same web codebase — but with a hard ceiling: **it runs in the iOS Simulator only.**

> **CEILING — Simulator only.** This project builds and runs in the **iOS Simulator on a Mac with
> Xcode**. **Code-signing, provisioning, an Apple Developer account, TestFlight, the App Store, real
> APNs push, and physical-device QA are OUT OF SCOPE** — deferred to a **future iOS-distribution
> epic** (see [`ADR-0005` addendum](../docs/decisions/ADR-0005-mobile-capacitor-hybrid.md) and
> [`SPRINTS.md`](../docs/agents/project/SPRINTS.md) → deferred scope). The Simulator proves the
> **build + web behaviour + degraded native**; it does **not** prove signing, distribution, real
> push, or real hardware.

> **TM-349 (wave-0 of epic TM-348):** scaffolded the Capacitor iOS platform (`ios/App`, PR #270) +
> the WebView env-signal contract (`App/App/TeamMarhabaViewController.swift`). **TM-353** extends the
> CI compile gate into a full Simulator smoke lane (boot a Simulator + assert the SPA renders).

## Hosted-URL load model (do not change without a ticket)

Identical to Android. Capacitor loads the **live hosted site** via `server.url` in
[`../capacitor.config.json`](../capacitor.config.json) (`https://teammarhaba.web.app`) instead of
bundling the web build into the `.app`. Every Firebase Hosting deploy therefore reaches the running
Simulator **instantly, with no rebuild** — there is **no web/feature rebuild** to run the iOS shell.
Capacitor adds only the native bridge + plugin layer on top.

`webDir` (`web/src`) is the fallback bundle Capacitor copies into the `.app` (`App/App/public/`,
gitignored); it is **not** what loads while `server.url` is set. (`web/src` is a no-build vanilla-JS
SPA, so there is no `dist/`.)

`appId` is **`app.teammarhaba.webview`** (shared with Android, from `capacitor.config.json`).

## WebView env-signal contract (auth)

The shell must signal "I am a WebView" so the web picks **redirect-mode** OAuth (a WebView has no
popup surface) and Google stays hidden on device (TM-275). Honoured by
`web/src/assets/auth-env.js#isWebViewEnv`, which is true if EITHER `window.TEAMMARHABA_WEBVIEW === true`
OR `typeof window.TeamMarhabaWebView !== "undefined"`. `TeamMarhabaViewController.swift` provides
**both**, plus a UA marker:

| Signal | Where |
|---|---|
| `window.TEAMMARHABA_WEBVIEW = true` injected at every page start | `TeamMarhabaViewController.swift` — a `WKUserScript` at `.atDocumentStart` (registered in `capacitorDidLoad`, before the first `loadWebView`) |
| `window.TeamMarhabaWebView` JS object (`getPlatform()` → `"ios"`, `isWebView()`, `getAppVersion()`) | the same injected `WKUserScript` — **not** a native message handler (see note below) |
| `TeamMarhabaWebView` appended to the User-Agent | `ios.appendUserAgent` in `capacitor.config.json` |

> **iOS vs Android bridge shape.** On Android, `TeamMarhabaWebView` is a **native** object exposed via
> `addJavascriptInterface` (`MainActivity.kt` + `TeamMarhabaJsBridge.kt`). On iOS, `WKWebView` native
> message handlers surface at `window.webkit.messageHandlers.<name>`, **not** `window.<name>` — so the
> iOS shell defines `window.TeamMarhabaWebView` as an **inert JS object inside the injected script**
> (its `getPlatform()` returns `"ios"`, the analogue of the Kotlin bridge's `"android"`). The web only
> needs the object to *exist* for `isWebViewEnv()`; both platforms satisfy the same contract, by
> different mechanisms.

First-party cookies + DOM storage for the Firebase `/__/auth/**` redirect + reCAPTCHA round-trip are
provided by Capacitor's default `WKWebView` configuration (cookie-store observer + `WKWebsiteDataStore`),
so **no extra cookie wiring** is needed on iOS (see
[`../docs/agents/webview-auth-contract.md`](../docs/agents/webview-auth-contract.md), which notes the
contract "covers iOS if a shell is ever added" — this shell is that). Avatar upload
(`<input id="profile-avatar-file">`) is serviced natively by Capacitor's `CAPBridgeViewController`.

## Native plugins

The same plugins declared in the root `package.json` (`@capacitor/app`, `@capacitor/geolocation`,
`@capacitor/camera`, `@capacitor/push-notifications`, `@aparajita/capacitor-biometric-auth`,
`@capacitor/splash-screen`) compile into the iOS project via **Swift Package Manager** (see
`App/CapApp-SPM/Package.swift`, which points each plugin at `../../../node_modules/**`).

Because the `WKWebView` loads the **hosted** site (`server.url`), the web JS cannot `import` these npm
packages — it calls them through the `window.Capacitor.Plugins.*` bridge Capacitor injects, and
degrades to a safe no-op in a plain browser (so the web build is unaffected). Note the **Simulator
degrades several of these** — see the matrix below.

> **SPM, not CocoaPods.** Capacitor 8 uses **Swift Package Manager**. `npx cap add ios` generated an
> **SPM**-based project (`App.xcodeproj` + `CapApp-SPM/Package.swift`) with **no `Podfile` and no
> `App.xcworkspace`** — so there is **no `pod install`** step anywhere. Open `App.xcodeproj` (not a
> workspace).

## Run iOS locally (Simulator)

**Prerequisites:** a **Mac** with **Xcode** (+ Command Line Tools) and at least one **iOS Simulator**
runtime installed (Xcode → Settings → Components), and **Node 22** (Capacitor 8 CLI requires
Node ≥22 — `cap sync` fatally aborts on Node 20). **No signing / Apple account is needed for a
Simulator.**

```bash
# from the repo root
npm ci
npx cap add ios          # ONLY if ios/ is absent — it already exists here (TM-349), so normally SKIP
npx cap sync ios         # installs plugins + copies the (fallback) web assets + generates config
npx cap run ios          # builds, boots an iOS Simulator, and launches the app
#   — or —
npx cap open ios         # opens App.xcodeproj in Xcode; pick an iPhone Simulator, then Run (⌘R)
```

`npx cap run ios` picks (or prompts for) a Simulator and boots it for you; `npx cap open ios` hands
off to Xcode where you choose the destination Simulator yourself. Either way the app loads the
**hosted** SPA over `server.url`, so you're testing live web + the native shell — **no web rebuild**.

> **Why `cap sync` first:** the Xcode build depends on the Capacitor `node_modules` (the SPM plugin
> packages resolve to `../../../node_modules/**`) and on the generated `capacitor.config.json` +
> copied web assets — all produced by `cap sync`, all **gitignored** (see `ios/.gitignore`). Always
> `npm ci && npx cap sync ios` before opening/building.

## Works vs degraded on the Simulator

What the **iOS Simulator** does and does **not** prove. (Mirrors the Android emulator split in
`../android/README.md` + [`../docs/qa/mobile-two-layer.md`](../docs/qa/mobile-two-layer.md), capped at
Simulator scope.)

### ✅ Full — behaves like a real device

| Capability | Notes |
|---|---|
| **WebView + hosted SPA** | `WKWebView` loads `https://teammarhaba.web.app` over `server.url` — the real product UI. |
| **Web UI + auth (redirect-mode OAuth)** | The env-signal contract makes `isWebViewEnv()` true, so OAuth uses `signInWithRedirect` and **Google stays hidden on device** (TM-275). Email-code + SMS (test number `+16505550100` → `123456`) work as on the web. |
| **Splash screen** | `@capacitor/splash-screen` renders from `capacitor.config.json` (`launchAutoHide: false`, brand colour). |
| **App lifecycle** | `@capacitor/app` `appStateChange` (foreground/background) fires — the re-lock-on-resume path works. |

### ⚠️ Degraded — works, but **not** the real thing (Simulator limitation)

| Capability | On the Simulator | How to exercise it |
|---|---|---|
| **Geolocation** | ✅ **simulated only** — returns an *injected* location, not a real GPS fix. | Xcode → **Features → Location** (Apple, Freeway Drive, Custom…), or `xcrun simctl location <device> set <lat>,<lon>`. |
| **Face ID / biometric** | ✅ **faked** — works only against an *enrolled* Simulator, matched via a menu, never a real face/finger. | Xcode → **Features → Face ID → Enrolled**, then **Features → Face ID → Matching Face** (or Non-matching to test failure). |
| **Camera** | ⚠️ **gallery / library path only — NO capture.** The Simulator has no camera hardware, so live capture is unavailable; the **photo library** picker works. | Pick from the library; drag images into the Simulator to seed the library first. |
| **Push notifications** | ❌ **no real APNs, no device token.** The shell registers no `aps-environment` entitlement and does no `registerForRemoteNotifications`, so a genuine APNs token / delivery is impossible here. Only **local** payloads work. Any push-token diagnostic reads **null — that is expected**, not a bug. | `xcrun simctl push <device> app.teammarhaba.webview <payload.apns>` delivers a **local** notification only (no server, no APNs). Real push needs a signed build on a **physical device** + an APNs key — the deferred epic. |

> **Rule of thumb:** the Simulator proves **the app builds, the hosted SPA + web auth behave, and the
> native plugins are wired**. It does **not** prove **code-signing, real APNs push, real camera
> capture, or real biometrics** — those need the deferred device/distribution epic (see the
> [`ADR-0005` addendum](../docs/decisions/ADR-0005-mobile-capacitor-hybrid.md)).

## Project layout

```
/                              # repo root
├── package.json               # @capacitor/core + cli + ios (+ android) + plugins
├── capacitor.config.json      # appId, appName, server.url, ios.appendUserAgent
└── ios/
    ├── .gitignore             # App/build, App/App/public, App/App/capacitor.config.json, DerivedData…
    ├── debug.xcconfig
    └── App/
        ├── App.xcodeproj/     # the Xcode project (NO .xcworkspace — SPM, not CocoaPods)
        ├── CapApp-SPM/        # Swift Package that pulls the Capacitor plugin packages from node_modules
        │   └── Package.swift
        └── App/
            ├── AppDelegate.swift            # Capacitor app delegate (no push registration — by design)
            ├── TeamMarhabaViewController.swift  # CAPBridgeViewController + the WebView env-signal contract
            ├── Info.plist                   # NO push entitlement / usage strings yet (deferred)
            └── Assets.xcassets/             # AppIcon + Splash
```

> **Generated, gitignored, regenerated by `cap sync`:** `App/App/public/` (copied web assets),
> `App/App/capacitor.config.json`, `App/App/config.xml`, `capacitor-cordova-ios-plugins/`,
> `DerivedData/`, and `node_modules/`. Always `npm ci && npx cap sync ios` from the repo root before
> building.

## CI (compile gate)

`.github/workflows/ios-simulator.yml` (TM-349) is the green gate: on a **`macos-latest`** runner it
runs `npm ci` → `npx cap sync ios` → `xcodebuild -resolvePackageDependencies` → a Debug **`xcodebuild`**
build for the **`iphonesimulator`** SDK with **signing fully disabled**
(`CODE_SIGNING_ALLOWED=NO` / `-destination 'generic/platform=iOS Simulator'`). It's **path-gated** to
`ios/**` + `capacitor.config.json` + `package.json` (macOS minutes bill at ~10×, so web/backend-only
PRs skip it). There is **no `pod install`** step — SPM resolves plugins via `xcodebuild`.

> The **`ios` job in `test-suite.yml` is a separate, parked no-op** — it runs on **`ubuntu-latest`**
> and just echoes "iOS not available yet". A Linux runner **cannot** boot an iOS Simulator, so the
> journey suite needs a **macOS runner** before iOS surface tests can actually run (TM-353).

## Out of scope (future iOS-distribution epic — NOT TM-348)

Deferred entirely, and recorded in the [`ADR-0005` addendum](../docs/decisions/ADR-0005-mobile-capacitor-hybrid.md):

1. **Code-signing + provisioning** (signing identity, provisioning profile, team).
2. **Apple Developer Program** enrolment.
3. **TestFlight / App Store** archive + upload + notarization (the iOS counterpart of the Android
   signed-APK release path).
4. **Real APNs push** — entitlement + APNs key + a signed build; the Simulator can never prove it.
5. **Physical-device QA** — the iOS counterpart of Android's real-device manual test (TM-288).
