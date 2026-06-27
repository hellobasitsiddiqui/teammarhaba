// Hide the "Get the app" store badges inside the Android WebView (TM-330). The badges are a WEB-only
// CTA — they nudge a browser visitor to install the native app. Inside the installed app (the
// Capacitor/Android WebView shell) they're nonsensical: "Download for Android" while you're already
// IN the Android app. They live as static HTML in index.html's footer (TM-276), so without a runtime
// gate the WebView shell inherits and renders them too.
//
// Mirrors the Google-sign-in hide (login.js, TM-275): `isWebViewEnv()` reads the native shell's
// signal (`window.TEAMMARHABA_WEBVIEW` / the `TeamMarhabaWebView` JS bridge); on a normal page load
// it's false, so this is inert and the badges still show in every browser. We set `hidden` rather
// than `remove()` so there's no layout reflow surprise and the element stays inspectable; the footer
// has no fixed height, so a hidden block leaves no gap.
import { isWebViewEnv } from "./auth-env.js";

if (isWebViewEnv()) {
  const badges = document.getElementById("app-store-badges");
  if (badges) badges.hidden = true;
}
