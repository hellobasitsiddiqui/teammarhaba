package app.teammarhaba.webview

import android.webkit.JavascriptInterface

/**
 * JS bridge injected into the WebView as `window.TeamMarhabaWebView` (TM-231).
 *
 * Per docs/agents/webview-auth-contract.md §1, the shell must signal it is a WebView so
 * `web/src/assets/auth-env.js#isWebViewEnv` picks redirect-mode sign-in (a WebView has no popup
 * surface). `isWebViewEnv` returns true if EITHER `window.TEAMMARHABA_WEBVIEW === true` OR
 * `typeof window.TeamMarhabaWebView !== "undefined"`. We do BOTH (belt and braces): set the boolean
 * via an injected script at document start, AND register this named interface object.
 *
 * Methods are exposed to JS via @JavascriptInterface and run on a background binder thread, not the
 * UI thread — keep them trivial / thread-safe. We intentionally expose only inert signals + a reload
 * hook (used by the local offline page's Retry button); no app-data access, so adding this bridge
 * widens no attack surface beyond "this is a WebView".
 *
 * @param nativeVersionName the running APK's versionName.
 * @param onReload invoked when JS asks the shell to reload the hosted app (offline-page Retry); the
 *   Activity supplies a callback that hops back to the UI thread and reloads APP_URL.
 */
class TeamMarhabaJsBridge(
    private val nativeVersionName: String,
    private val onReload: () -> Unit,
) {

    /** The native shell's versionName — lets the web side display/inspect the host app version. */
    @JavascriptInterface
    fun getAppVersion(): String = nativeVersionName

    /** Explicit "I am the TeamMarhaba native shell" signal, mirrored by window.TEAMMARHABA_WEBVIEW. */
    @JavascriptInterface
    fun isWebView(): Boolean = true

    /** Platform tag, in case the web side ever wants to branch on host (android vs a future ios). */
    @JavascriptInterface
    fun getPlatform(): String = "android"

    /** Reload the hosted app — used by the offline page's Retry button. Runs off the UI thread. */
    @JavascriptInterface
    fun reload() {
        onReload()
    }
}
