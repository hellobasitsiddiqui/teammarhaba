# ProGuard / R8 rules for the TeamMarhaba WebView shell (TM-231).
#
# The app is almost entirely a WebView around hosted web code, so there is little to keep beyond the
# defaults. Keep the JS bridge interface's annotated members — R8 would otherwise strip methods that
# are only ever invoked from JavaScript, breaking the @JavascriptInterface bridge.
-keepclassmembers class app.teammarhaba.webview.** {
    @android.webkit.JavascriptInterface <methods>;
}
