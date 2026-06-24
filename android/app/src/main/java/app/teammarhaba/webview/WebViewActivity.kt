package app.teammarhaba.webview

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import app.teammarhaba.webview.databinding.ActivityWebviewBinding
import kotlinx.coroutines.launch

/**
 * The single WebView Activity (TM-231) — a thin native shell around the hosted web UI.
 *
 * Responsibilities, all per docs/agents/webview-auth-contract.md:
 *  - Load https://teammarhaba.web.app (BuildConfig.APP_URL) with DOM storage + cookies enabled.
 *  - Signal "I am a WebView" two ways: window.TEAMMARHABA_WEBVIEW = true + the TeamMarhabaJsBridge
 *    object — so auth-env.js picks redirect-mode sign-in.
 *  - Let same-origin navigations (incl. the Firebase /__/auth/ redirect + reCAPTCHA round-trip) load
 *    in the WebView; open genuinely external links in the system browser.
 *  - Hardware back-button = WebView history back; exit when there's nothing to go back to.
 *  - onShowFileChooser wired to the avatar file <input id="profile-avatar-file"> (accepts any image).
 *  - Offline page when the main frame fails to load; pull-to-refresh to reload.
 *  - On launch, run the lightweight auto-update check and prompt if a newer web build is live.
 */
class WebViewActivity : AppCompatActivity() {

    private lateinit var binding: ActivityWebviewBinding
    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout

    /** Pending file-chooser callback from onShowFileChooser — MUST be resolved (incl. null on cancel). */
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    /** True while the offline error page is showing, so a successful reload can restore the app. */
    private var showingOffline = false

    // --- Avatar file chooser: launches the system picker, routes the result back to the WebView ----
    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            // ALWAYS resolve the callback — dropping it wedges the <input> so a retry can't reopen the
            // chooser (webview-auth-contract §4). On cancel / no data we pass null.
            val callback = fileChooserCallback
            fileChooserCallback = null
            if (callback == null) return@registerForActivityResult

            val uris: Array<Uri>? =
                if (result.resultCode == Activity.RESULT_OK) {
                    WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
                } else {
                    null
                }
            callback.onReceiveValue(uris)
        }

    // Camera permission request — granted/denied feeds back into how we build the chooser.
    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* result handled lazily */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityWebviewBinding.inflate(layoutInflater)
        setContentView(binding.root)

        webView = binding.webView
        swipeRefresh = binding.swipeRefresh

        configureWebView()
        configureBackNavigation()
        configurePullToRefresh()

        if (savedInstanceState == null) {
            webView.loadUrl(BuildConfig.APP_URL)
            checkForUpdate()
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    @Suppress("SetJavaScriptEnabled")
    private fun configureWebView() {
        // First-party cookies are required for the Firebase auth redirect handler to persist state
        // across the /__/auth/** round-trip (webview-auth-contract §2).
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            // DOM storage MUST stay enabled — Firebase persists the redirect "initial state" there;
            // disabling it reproduces auth/missing-initial-state even with a first-party handler.
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            // The web UI is responsive (TM-229); use the device viewport, no desktop UA.
            useWideViewPort = true
            loadWithOverviewMode = true
            mediaPlaybackRequiresUserGesture = true
            // Popups have no surface in a WebView; auth uses redirect instead, so leave these off.
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            allowFileAccess = false
            allowContentAccess = false
        }

        // Signal #2 of the WebView contract: the named JS bridge object. The reload hook (used by the
        // offline page's Retry button) hops to the UI thread before touching the WebView.
        webView.addJavascriptInterface(
            TeamMarhabaJsBridge(BuildConfig.VERSION_NAME) {
                webView.post { reloadApp() }
            },
            "TeamMarhabaWebView",
        )

        webView.webViewClient = TmWebViewClient()
        webView.webChromeClient = TmWebChromeClient()
    }

    private fun configureBackNavigation() {
        // Hardware/gesture back goes back through WebView history; falls through to default (exit /
        // finish) when there's nothing left to pop.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    private fun configurePullToRefresh() {
        swipeRefresh.setColorSchemeResources(R.color.tm_primary)
        swipeRefresh.setOnRefreshListener {
            if (showingOffline) {
                reloadApp()
            } else {
                webView.reload()
            }
        }
        // Only allow the pull gesture when the WebView is scrolled to the very top — otherwise it
        // fights with in-page scrolling.
        swipeRefresh.setOnChildScrollUpCallback { _, _ -> webView.scrollY > 0 }
    }

    private fun checkForUpdate() {
        lifecycleScope.launch {
            val result = UpdateChecker.check(BuildConfig.APP_URL, BuildConfig.VERSION_NAME)
            if (result.updateAvailable && !isFinishing) {
                AlertDialog.Builder(this@WebViewActivity)
                    .setTitle(R.string.update_title)
                    .setMessage(
                        getString(
                            R.string.update_message,
                            result.installedVersion,
                            result.latestVersion ?: "",
                        ),
                    )
                    .setPositiveButton(R.string.update_download) { _, _ ->
                        // Send the user to the download/distribution page. The hosted app serves a
                        // /download landing page (documented in android/README distribution section);
                        // open it in the system browser so the APK download + installer can run.
                        openExternal("${BuildConfig.APP_URL.trimEnd('/')}/download")
                    }
                    .setNegativeButton(R.string.update_later, null)
                    .show()
            }
        }
    }

    /** Leave the offline page and (re)load the hosted app. Safe to call from the UI thread only. */
    private fun reloadApp() {
        showingOffline = false
        webView.loadUrl(BuildConfig.APP_URL)
    }

    private fun openExternal(url: String) {
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }
    }

    /** Is [url] on the hosted app's origin? Same-origin navigations load inside the WebView. */
    private fun isAppOrigin(url: String?): Boolean {
        if (url == null) return false
        val appHost = Uri.parse(BuildConfig.APP_URL).host ?: return false
        val host = runCatching { Uri.parse(url).host }.getOrNull() ?: return false
        return host.equals(appHost, ignoreCase = true)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
        CookieManager.getInstance().flush() // persist auth cookies promptly
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        // Resolve any dangling chooser callback so we never leak a wedged <input>.
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        super.onDestroy()
    }

    // ----------------------------------------------------------------------------------------------
    private inner class TmWebViewClient : WebViewClient() {

        override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
            super.onPageStarted(view, url, favicon)
            // Inject the boolean WebView signal at the start of every page load (belt-and-braces with
            // the JS bridge), so auth-env.js sees it before it decides popup-vs-redirect.
            view?.evaluateJavascript("window.TEAMMARHABA_WEBVIEW = true;", null)
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            swipeRefresh.isRefreshing = false
        }

        override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: WebResourceRequest?,
        ): Boolean {
            val url = request?.url?.toString() ?: return false
            // Same-origin (incl. /__/auth/** redirect + reCAPTCHA handler) MUST load in the WebView —
            // do NOT intercept (webview-auth-contract §2). External links open in the system browser.
            return if (isAppOrigin(url)) {
                false // let the WebView load it
            } else {
                openExternal(url)
                true // we handled it
            }
        }

        override fun onReceivedError(
            view: WebView?,
            request: WebResourceRequest?,
            error: WebResourceError?,
        ) {
            super.onReceivedError(view, request, error)
            // Only the MAIN frame failing should swap in the offline page — ignore sub-resource errors.
            if (request?.isForMainFrame == true) {
                showOfflinePage()
            }
        }

        private fun showOfflinePage() {
            showingOffline = true
            webView.loadUrl("file:///android_asset/offline.html")
        }
    }

    // ----------------------------------------------------------------------------------------------
    private inner class TmWebChromeClient : WebChromeClient() {

        /** Avatar upload: service the HTML file input (webview-auth-contract §4). */
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?,
        ): Boolean {
            // Replace any stale callback, resolving it null first so a previous open never wedges.
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback = filePathCallback

            val intent = fileChooserParams?.createIntent()
            if (intent == null) {
                // No usable chooser intent — resolve null so the input can be retried.
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = null
                return false
            }

            // Offer camera capture too when CAMERA is granted; the input is accept="image/*", so the
            // system chooser already filters to images. (Request permission so "take photo" works.)
            ensureCameraPermission()

            return try {
                fileChooserLauncher.launch(intent)
                true
            } catch (_: Exception) {
                // Couldn't launch — never drop the callback.
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = null
                false
            }
        }

        override fun onPermissionRequest(request: PermissionRequest?) {
            // The web reCAPTCHA / camera-getUserMedia paths may request resources; grant only what the
            // app legitimately needs. For now we deny by default (avatar upload uses the file chooser,
            // not getUserMedia), which is the safe choice; revisit if a feature needs it.
            request?.deny()
        }
    }

    private fun ensureCameraPermission() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }
}
