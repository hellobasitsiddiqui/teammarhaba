# webview

Shared WebView assets/wrapper — the web UI packaged for embedding inside the native shells.

The native shell now lives in **[`../android/`](../android/)** (implemented in **TM-231**) — a thin
Kotlin WebView wrapper around the hosted web UI, shipped as a direct-download APK. See
[`android/README.md`](../android/README.md) for build/sign/distribute docs.

This `webview/` directory is the place for any future **shared** WebView assets used across native
shells (e.g. an iOS shell, if one is ever added). Today the only shell is Android, and its WebView
assets (the offline page, the JS bridge) live with it under `android/app/src/main/`; there are no
shared assets to host here yet.

The web + Firebase Hosting side of mobile/WebView auth hardening is done in **TM-230**. Before
changing the shell's auth/upload behaviour, read
**[`../docs/agents/webview-auth-contract.md`](../docs/agents/webview-auth-contract.md)** — it
specifies exactly what the WebView must do (signal itself as a WebView, allow the `/__/auth/**`
redirect to complete with DOM storage/cookies enabled, expect the phone-auth reCAPTCHA fallback, and
wire `onShowFileChooser` for the `profile-avatar-file` upload input).
