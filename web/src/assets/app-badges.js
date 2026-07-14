// "Get the app" store badges runtime behaviour.
//
// (1) Inside the Android/iOS WebView (TM-330): hide the badges entirely — they're a WEB-only CTA
//     (nudging a browser visitor to install the native app) and nonsensical in the installed shell
//     ("Download for Android" while you're already IN the Android app). They're static HTML in
//     index.html's footer (TM-276), so without a runtime gate the shell would inherit them.
//     `isWebViewEnv()` reads the native signal (`window.TEAMMARHABA_WEBVIEW` / the `TeamMarhabaWebView`
//     bridge); on a normal page load it's false, so this stays inert. We set `hidden` (not `remove()`)
//     so there's no reflow surprise and the node stays inspectable.
//
// (2) On mobile-web / desktop (TM-657): the iOS badge is a disabled "Coming soon" placeholder (no iOS
//     app yet — TM-233 parked). A `disabled` <button> emits NO click, so a tap on it is a dead no-op
//     that reads as broken. Make it tappable (keeping it announced as unavailable via aria-disabled and
//     the dimmed `.store-badge-disabled` look) and answer a tap with an honest toast instead of silence.
import { isWebViewEnv } from "./auth-env.js";
import { toast } from "./ui.js";

if (isWebViewEnv()) {
  const badges = document.getElementById("app-store-badges");
  if (badges) badges.hidden = true;
} else {
  const ios = document.querySelector("#app-store-badges .store-badge-disabled");
  if (ios) {
    // Make the "Coming soon" badge give feedback on tap instead of being a silent dead button. It stays
    // aria-disabled (announced unavailable) and keeps its dimmed styling, so it never looks like a live
    // download — it just explains itself when tapped rather than doing nothing (TM-657).
    ios.removeAttribute("disabled");
    ios.setAttribute("aria-disabled", "true");
    ios.addEventListener("click", (event) => {
      event.preventDefault();
      toast("The iOS app isn't out yet — coming soon. Grab the Android app for now.", { type: "info" });
    });
  }
}
