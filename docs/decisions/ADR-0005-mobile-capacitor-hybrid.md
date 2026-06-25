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
