# ADR-0005: Capacitor hybrid for the mobile apps (not full native)

- **Status:** Accepted
- **Date:** 2026-06-25
- **Ticket:** TM-277

## Context

The mobile surface shipped as a thin hand-rolled Android WebView shell (TM-231) that loads the hosted web SPA (`teammarhaba.web.app`). The product then required real native device capabilities: **push notifications (hard requirement)**, plus **GPS, camera, and biometric/fingerprint** security.

Forces at play:

- A plain WebView can only reach native features through bespoke per-feature JS↔native bridges, each hand-written and maintained.
- Google **blocks OAuth inside embedded WebViews** (`disallowed_useragent`) — so Google sign-in can't run in the WebView regardless (handled separately by hiding it on-device, TM-275).
- The entire UI is one framework-free web codebase; every web deploy currently reaches the app instantly with no APK rebuild.

Options on the table:

1. **Keep the hand-rolled WebView** and write a bespoke native bridge per capability.
2. **Full native rewrite** (Kotlin/Compose) — re-implement the whole UI natively (~22 tickets, ~6–9 person-weeks) plus a permanent dual-codebase maintenance tax; iOS would double it again.
3. **Capacitor hybrid** — wrap the existing web app; reach native features through maintained Capacitor plugins.

## Decision

**We will adopt Capacitor (v8) as the hybrid mobile container (epic TM-277), replacing the hand-rolled WebView shell.** The app loads the hosted site (`server.url`), and native capabilities come from official/community Capacitor plugins.

Rationale:

- **One web codebase, instant updates retained** — UI changes still ship as web deploys; only native-plugin changes need an APK rebuild.
- **Native features via maintained plugins** — push (`@capacitor/push-notifications` → FCM), `@capacitor/geolocation`, `@capacitor/camera`, a biometric plugin → `BiometricPrompt` — instead of hand-rolling each bridge.
- **Server-side push reuses existing wiring** — FCM send goes through the Firebase Admin SDK already present in the backend.
- **iOS becomes the same web code**, a cheap follow-on rather than a second full rewrite.
- **Avoids the full-native cost** (≈22 tickets + dual-codebase tax) for capabilities a hybrid delivers in ≈12.

## Consequences

- **Positive:**
  - Push/GPS/camera/biometric delivered on the existing web UI (~12 tickets vs ~22 native).
  - UI iteration keeps the ~3–4 min web-deploy cadence; no Play Store review on UI changes.
  - iOS is an incremental follow-on (same code + APNs), not a rewrite.
  - The Capacitor `BridgeActivity` gives the plugin tickets a real native host.
- **Cost / trade-off:**
  - **Native-plugin changes require an APK rebuild + redistribution** (not web-deployable).
  - **Capacitor 8 CLI requires Node ≥22** — CI jobs running `cap sync` must pin Node 22.
  - The hand-rolled WebView shell (TM-231) is **replaced** by the Capacitor Android project; the WebView env-signal contract (`window.TEAMMARHABA_WEBVIEW` / the JS bridge, so `isWebViewEnv()` keeps hiding Google on-device) had to be ported into the new `MainActivity`.
  - A release keystore + signed-APK pipeline is now on the critical path.
- **Follow-on work:** signing keystore custody (TM-245 / TM-286), signed-APK CI (TM-287), real-device QA (TM-288), and iOS as a future epic.

## References

- Epic **TM-277** and tasks TM-278…TM-288.
- Supersedes the thin hand-rolled WebView approach of **TM-231** (shell now Capacitor-owned).
- Relates **ADR-0004** (Firebase Authentication) and `docs/agents/webview-auth-contract.md`.

---

## Addendum — iOS ships to the **Simulator only** (2026-07-02, epic TM-348)

The original decision above framed iOS as "the same web code + APNs, a cheap follow-on" (lines 32 / 40 / 47). The **iOS-Simulator epic (TM-348)** actually delivers that follow-on — but with a hard ceiling that those lines under-specified, recorded here so nobody reads the shipped iOS work as more than it is.

**What TM-348 delivers (the ceiling):** a Capacitor 8 iOS project (`ios/App`, scaffolded in **TM-349** / PR #270) that builds and runs **in the iOS Simulator on a Mac with Xcode**, loading the same hosted SPA (`server.url = https://teammarhaba.web.app`) through a `WKWebView`, with the same WebView env-signal contract the Android shell provides (see `ios/README.md` and `docs/agents/webview-auth-contract.md`). The CI gate is a Debug **`xcodebuild`** compile for the `iphonesimulator` SDK with signing disabled, on a **`macos-latest`** runner (`.github/workflows/ios-simulator.yml`).

**Explicitly DEFERRED to a separate later epic (NOT in TM-348):**

- **Code-signing & provisioning** — no signing identity, no provisioning profile, no team. The Simulator needs none (`CODE_SIGNING_ALLOWED=NO`), so none is wired.
- **Apple Developer Program membership** — not enrolled.
- **TestFlight / App Store distribution** — no archive/upload/notarization pipeline (the iOS analogue of the Android signed-APK release path in ADR TM-286/287 does **not** exist yet).
- **Real APNs push** — deferred, and importantly **the Simulator cannot prove it at all.** This refines line 40 ("same code + APNs"): APNs is *not* a Simulator capability. The iOS shell registers **no** push entitlement / `aps-environment`, and `AppDelegate` does no `registerForRemoteNotifications` — so there is **no real device token**. Push can only be exercised as **local `xcrun simctl push` payloads**; a genuine APNs round-trip needs a signed build on a physical device + an APNs key. See the degradation matrix in `ios/README.md`.
- **Physical-device QA** — no real-iPhone sign-off (the iOS counterpart of Android's TM-288 real-device test). The Simulator can't reproduce Safari ITP, real biometrics, a real camera, real push delivery, or real cellular.

**Net:** the Simulator is a **build + web-behaviour + degraded-native** proof, **not** a signing / distribution / real-push / real-device proof — exactly the same "emulator catches most; device is the gate" split ADR-0004 / `docs/qa/mobile-two-layer.md` already draw for Android. The deferred items above are a **future iOS-distribution epic** (see `docs/agents/project/SPRINTS.md` → deferred scope), not TM-348.

- iOS-Simulator epic **TM-348**; scaffold **TM-349** (PR #270); Simulator smoke-lane follow-on **TM-353**.
