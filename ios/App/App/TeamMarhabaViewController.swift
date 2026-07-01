import Capacitor
import UIKit
import WebKit

/// The Capacitor host view controller (TM-349) — the iOS analogue of Android's `MainActivity.kt`.
///
/// Capacitor's `CAPBridgeViewController` owns the `WKWebView` and loads `server.url`
/// (`https://teammarhaba.web.app`, see ../../../capacitor.config.json) — the HOSTED-URL load model,
/// so every web deploy reaches the Simulator instantly with no rebuild. This subclass only
/// re-establishes the WebView env-signal contract the Android shell already provides, so the web
/// auth flows behave the same inside the iOS WKWebView.
///
/// WebView env-signal contract (docs/agents/webview-auth-contract.md §1 / web/src/assets/auth-env.js
/// `isWebViewEnv`): the shell must signal "I am a WebView" so OAuth uses redirect (a WebView has no
/// popup surface) and Google stays hidden on device (TM-275). `isWebViewEnv` returns true if EITHER
/// `window.TEAMMARHABA_WEBVIEW === true` OR `typeof window.TeamMarhabaWebView !== "undefined"`.
/// We provide BOTH from a single document-start user script (belt-and-braces), plus a UA marker via
/// `ios.appendUserAgent` in capacitor.config.json (applied by Capacitor's `webViewConfiguration`).
///
/// Unlike Android — where `TeamMarhabaJsBridge` is a native object exposed via
/// `addJavascriptInterface` — WKWebView's native message handlers surface at
/// `window.webkit.messageHandlers.<name>`, not `window.<name>`. So instead of a native bridge we
/// define the `window.TeamMarhabaWebView` object (with inert `getPlatform()`/`isWebView()`/
/// `getAppVersion()` signals) directly in the injected script. `getPlatform()` returns `"ios"` — the
/// analogue of the Kotlin bridge's `"android"`, whose comment anticipated a future iOS shell.
///
/// The script runs at `.atDocumentStart` on every navigation (registered in `capacitorDidLoad`,
/// which fires before the first `loadWebView`), so the flags exist before auth-env.js decides
/// popup-vs-redirect — matching the Android `onPageStarted` injection but earlier and more reliable.
///
/// First-party + DOM storage for the Firebase `/__/auth/` redirect round-trip (webview-auth-contract
/// §2) are already provided by Capacitor's default WKWebView configuration (cookie store observer +
/// WKWebsiteDataStore), so no extra cookie wiring is needed here. This controller intentionally adds
/// NO push/APNs entitlements, signing, or Info.plist usage strings — those are separate tickets.
class TeamMarhabaViewController: CAPBridgeViewController {

    /// The running app's short version (`CFBundleShortVersionString`), the iOS analogue of the
    /// Android bridge's `BuildConfig.VERSION_NAME`. Empty string if unavailable.
    private static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

    /// JS injected at the start of every page load. Sets the boolean flag AND defines the named
    /// bridge object so `isWebViewEnv()` is satisfied by either signal, and exposes inert
    /// `getPlatform()` (returns `"ios"`) / `isWebView()` / `getAppVersion()` for host parity with the
    /// Android bridge. The version is interpolated as a JSON string literal so it is always safely
    /// quoted.
    private static func webViewSignalScript() -> String {
        let versionLiteral = jsStringLiteral(appVersion)
        return """
        (function () {
          window.TEAMMARHABA_WEBVIEW = true;
          window.TeamMarhabaWebView = window.TeamMarhabaWebView || {
            getPlatform: function () { return "ios"; },
            isWebView: function () { return true; },
            getAppVersion: function () { return \(versionLiteral); }
          };
        })();
        """
    }

    /// Encode a Swift string as a safe JS/JSON double-quoted literal for inlining into the script.
    private static func jsStringLiteral(_ value: String) -> String {
        if let data = try? JSONSerialization.data(withJSONObject: [value]),
           let json = String(data: data, encoding: .utf8) {
            // JSONSerialization emits an array like ["1.0.0"]; strip the surrounding brackets.
            return String(json.dropFirst().dropLast())
        }
        return "\"\""
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()

        // The WKWebView and its final userContentController exist by now (prepareWebView has run),
        // and this fires before loadWebView(), so a .atDocumentStart script is guaranteed to run
        // on the first (and every) page load.
        let userScript = WKUserScript(
            source: TeamMarhabaViewController.webViewSignalScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        webView?.configuration.userContentController.addUserScript(userScript)
    }
}
