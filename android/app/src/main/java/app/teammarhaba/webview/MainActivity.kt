package app.teammarhaba.webview

import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener

/**
 * The Capacitor host Activity (TM-278) — wraps the hosted TeamMarhaba web UI.
 *
 * Capacitor's [BridgeActivity] owns the WebView and loads `server.url`
 * (`https://teammarhaba.web.app`, see ../../../../../capacitor.config.json) — the HOSTED-URL load
 * model, so every web deploy reaches the device instantly with no APK rebuild. Capacitor adds the
 * native bridge + plugin layer on top; this subclass only re-establishes the WebView env-signal
 * contract the previous hand-rolled shell (TM-231) provided, so the web auth flows behave the same.
 *
 * WebView env signal contract (docs/agents/webview-auth-contract.md §1 / web/src/assets/auth-env.js
 * `isWebViewEnv`): the shell must signal "I am a WebView" so OAuth uses redirect (a WebView has no
 * popup surface) and Google stays hidden on device (TM-275). `isWebViewEnv` returns true if EITHER
 * `window.TEAMMARHABA_WEBVIEW === true` OR `typeof window.TeamMarhabaWebView !== "undefined"`. We do
 * BOTH (belt-and-braces), plus a UA marker via `appendUserAgent` in capacitor.config.json:
 *   1. Register the named JS bridge object `TeamMarhabaWebView` (addJavascriptInterface).
 *   2. Inject `window.TEAMMARHABA_WEBVIEW = true` at the start of every page load.
 *
 * First-party cookies are enabled so the Firebase `/__/auth/` redirect + reCAPTCHA round-trip can
 * persist state across the navigation (webview-auth-contract §2). Capacitor enables DOM storage on
 * its WebView by default, which Firebase also needs for the redirect "initial state".
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val webView: WebView = bridge.webView

        // First-party + third-party cookies for the Firebase auth redirect handler round-trip.
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        // Signal #1: the named JS bridge object (window.TeamMarhabaWebView). Methods run on a binder
        // thread — keep them trivial/inert (version + platform tags only; no app-data access).
        webView.addJavascriptInterface(
            TeamMarhabaJsBridge(BuildConfig.VERSION_NAME),
            "TeamMarhabaWebView",
        )

        // Signal #2: set the boolean flag at the start of every page load so auth-env.js sees it
        // before it decides popup-vs-redirect (belt-and-braces with the named bridge above).
        bridge.addWebViewListener(
            object : WebViewListener() {
                override fun onPageStarted(view: WebView) {
                    view.evaluateJavascript("window.TEAMMARHABA_WEBVIEW = true;", null)
                }
            },
        )
    }
}
