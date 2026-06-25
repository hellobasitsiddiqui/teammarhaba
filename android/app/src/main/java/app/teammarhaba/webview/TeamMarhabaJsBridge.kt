package app.teammarhaba.webview

import android.webkit.JavascriptInterface

/**
 * JS bridge injected into the Capacitor WebView as `window.TeamMarhabaWebView` (TM-278, ported from
 * the TM-231 shell).
 *
 * Per docs/agents/webview-auth-contract.md §1, the shell must signal it is a WebView so
 * `web/src/assets/auth-env.js#isWebViewEnv` picks redirect-mode sign-in (a WebView has no popup
 * surface, and Google stays hidden on device — TM-275). `isWebViewEnv` returns true if EITHER
 * `window.TEAMMARHABA_WEBVIEW === true` OR `typeof window.TeamMarhabaWebView !== "undefined"`.
 * MainActivity registers this object AND sets the boolean flag (belt-and-braces).
 *
 * Methods are exposed to JS via @JavascriptInterface and run on a background binder thread — keep
 * them trivial / thread-safe. We expose only inert signals (version + platform), no app-data access,
 * so this widens no attack surface beyond "this is the TeamMarhaba native shell".
 *
 * @param nativeVersionName the running APK's versionName (BuildConfig.VERSION_NAME).
 */
class TeamMarhabaJsBridge(private val nativeVersionName: String) {

    /** The native shell's versionName — lets the web side display/inspect the host app version. */
    @JavascriptInterface
    fun getAppVersion(): String = nativeVersionName

    /** Explicit "I am the TeamMarhaba native shell" signal, mirrored by window.TEAMMARHABA_WEBVIEW. */
    @JavascriptInterface
    fun isWebView(): Boolean = true

    /** Platform tag, in case the web side ever wants to branch on host (android vs a future ios). */
    @JavascriptInterface
    fun getPlatform(): String = "android"
}
