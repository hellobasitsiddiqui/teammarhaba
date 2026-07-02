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
/// E2E PHONE-AUTH FLAG INJECTION (TM-354, Simulator only) — the iOS analogue of the Android CDP
/// injector (`android/maestro/inject-e2e-flag.mjs`). The SMS-login Maestro journey needs
/// `localStorage["tm_e2e_phone_test"] = "1"` set BEFORE `web/src/assets/auth.js` module-load so
/// `phone-e2e.js` disables reCAPTCHA app-verification for the Firebase test number (+16505550100 /
/// 123456; see login-sms.yaml). The Android mechanism (adb-forward a TCP port to the WebView devtools
/// socket → CDP `localStorage.setItem`) does NOT port to WKWebView: there is no adb, and the iOS
/// WebView debugger is Safari `webinspectord`, not CDP. Rather than reach for `ios-webkit-debug-proxy`
/// / webinspectord (flaky, extra tooling, and it races auth.js's module-load read), we set the flag
/// from INSIDE this same `.atDocumentStart` user script — which is guaranteed to run before any page
/// script, so `auth.js` reads the flag on its very first load with no reload dance.
///
/// The flag line is emitted ONLY when a non-prod TEST-MODE signal is present — the launch argument
/// `-tmE2EPhoneTest` OR the environment variable `TM_E2E_PHONE_TEST=1` (see `e2ePhoneTestRequested`).
/// The CI Maestro lane passes these via `xcrun simctl launch --console <udid> <id> -tmE2EPhoneTest`
/// (arg) and/or `SIMCTL_CHILD_TM_E2E_PHONE_TEST=1` (env); the App Store binary is never launched with
/// either, so the flag is emitted NOWHERE in production. And even if it somehow were, `phone-e2e.js`'s
/// second (context-safe) gate still holds — the point of that gate — so this cannot weaken reCAPTCHA
/// on the public https site. This is a launch-time signal read once at startup, mirroring the
/// Android debug-build gate (WebView debugging on for debug, off for release).
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

    /// The launch argument the CI Simulator lane passes to request the phone-auth e2e flag.
    private static let e2ePhoneTestLaunchArg = "-tmE2EPhoneTest"
    /// The environment variable equivalent (e.g. `SIMCTL_CHILD_TM_E2E_PHONE_TEST=1` → `TM_E2E_PHONE_TEST`).
    private static let e2ePhoneTestEnvVar = "TM_E2E_PHONE_TEST"

    /// TM-354 — is the non-prod phone-auth e2e flag REQUESTED at launch? True when the process was
    /// started with the `-tmE2EPhoneTest` launch argument OR `TM_E2E_PHONE_TEST=1` in the environment.
    /// Read from `ProcessInfo` so it reflects exactly what `xcrun simctl launch` passed; neither is ever
    /// passed to the App Store binary, so this is false in production. When true, the document-start
    /// script also sets `localStorage["tm_e2e_phone_test"]="1"` so `auth.js` skips reCAPTCHA for the
    /// Firebase test number (the context-safe half of the gate still applies — see the class doc).
    private static var e2ePhoneTestRequested: Bool {
        let info = ProcessInfo.processInfo
        if info.arguments.contains(e2ePhoneTestLaunchArg) { return true }
        return info.environment[e2ePhoneTestEnvVar] == "1"
    }

    /// JS injected at the start of every page load. Sets the boolean flag AND defines the named
    /// bridge object so `isWebViewEnv()` is satisfied by either signal, and exposes inert
    /// `getPlatform()` (returns `"ios"`) / `isWebView()` / `getAppVersion()` for host parity with the
    /// Android bridge. The version is interpolated as a JSON string literal so it is always safely
    /// quoted.
    private static func webViewSignalScript() -> String {
        let versionLiteral = jsStringLiteral(appVersion)
        // TM-354: only when the non-prod test-mode signal is present, ALSO persist the phone-auth
        // e2e flag so auth.js/phone-e2e.js disables reCAPTCHA for the Firebase test number. The write
        // is try/guarded because localStorage can throw on a locked-down/partitioned document (fails
        // closed → no bypass), matching phone-e2e.js's own defensive read. Empty when not requested,
        // so the injected script is byte-identical to the pre-TM-354 script in production.
        let e2ePhoneFlagLine = e2ePhoneTestRequested
            ? """
              try { window.localStorage.setItem("tm_e2e_phone_test", "1"); } catch (e) {}
            """
            : ""
        return """
        (function () {
          window.TEAMMARHABA_WEBVIEW = true;
          window.TeamMarhabaWebView = window.TeamMarhabaWebView || {
            getPlatform: function () { return "ios"; },
            isWebView: function () { return true; },
            getAppVersion: function () { return \(versionLiteral); }
          };\(e2ePhoneFlagLine)
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
