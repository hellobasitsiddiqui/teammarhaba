# webview

Shared WebView assets/wrapper — the web UI packaged for embedding inside the native shells.

Stub — the native shell implementation lands in **TM-231**.

The web + Firebase Hosting side of mobile/WebView auth hardening is done in **TM-230**. Before
building the shell, read **[`docs/agents/webview-auth-contract.md`](../docs/agents/webview-auth-contract.md)**
— it specifies exactly what the WebView must do (signal itself as a WebView, allow the `/__/auth/**`
redirect to complete with DOM storage/cookies enabled, expect the phone-auth reCAPTCHA fallback, and
wire `onShowFileChooser` for the `profile-avatar-file` upload input).
