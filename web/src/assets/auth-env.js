// Auth environment detection (TM-230) — decides which Firebase redirect strategy to use.
//
// Pulled out of auth.js into its own pure module for two reasons:
//   1. It's the one piece of the mobile/WebView auth-hardening that is unit-testable WITHOUT a
//      browser or the Firebase SDK — feed it a user-agent string, assert the decision. The
//      framework-free repo runs these as `node --test web/**/*.test.mjs` on the PR gate, so the
//      "mobile uses redirect, not popup" contract is guarded by a real test (TM-230 AC).
//   2. It keeps auth.js focused on the Firebase calls; this module has zero Firebase imports.
//
// Why it matters: `signInWithPopup` is unreliable on phones — mobile browsers block or mis-handle
// the popup, and an Android WebView has no popup surface at all — so redirect-based sign-in
// (`signInWithRedirect` + `getRedirectResult`) is the correct path there. Desktop keeps the popup
// (no full-page navigation, snappier). This only affects redirect/OAuth providers (Google — parked
// under TM-200); email-code (custom token) and SMS (reCAPTCHA) don't go through popup/redirect here.

/**
 * Is this user-agent a phone/tablet browser? Deliberately conservative — a coarse mobile-form-factor
 * heuristic, not device fingerprinting. We only need "is a popup unlikely to work well here", and on
 * a false negative the popup still mostly works on modern mobile; a false positive (redirect on
 * desktop) is merely a full-page nav. Tablets count as mobile (touch, popup-averse).
 * @param {string} ua a navigator.userAgent string.
 * @returns {boolean}
 */
export function isMobileUserAgent(ua) {
  if (!ua || typeof ua !== "string") return false;
  return /Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile|Mobile Safari/i.test(
    ua,
  );
}

/**
 * Is this an Android WebView (our native shell, TM-231, embeds the web UI in one)? Android WebViews
 * carry the `; wv` token in the UA, OR the legacy `Version/x.x ... Chrome/x.x Mobile` shape with the
 * `wv` marker. We treat any WebView as redirect-only: there is no popup window inside a WebView, so
 * `signInWithPopup` cannot succeed there — it must use `signInWithRedirect`.
 *
 * iOS WKWebView does NOT reliably advertise itself in the UA, so this can't catch it from the UA
 * alone; the native shell should additionally signal it (see `isWebViewEnv`). Android — our only
 * planned shell (TM-231) — is detectable here.
 * @param {string} ua a navigator.userAgent string.
 * @returns {boolean}
 */
export function isAndroidWebViewUserAgent(ua) {
  if (!ua || typeof ua !== "string") return false;
  // Standard Android System WebView marker.
  if (/;\s*wv\)/i.test(ua)) return true;
  // Older WebViews: "Version/4.0" present alongside Chrome on Android but no "wv" — match the
  // classic WebView signature (Version/ + Chrome + Mobile Safari) that standalone Chrome lacks.
  return /\bVersion\/[\d.]+\b/i.test(ua) && /\bChrome\/[\d.]+\b/i.test(ua) && /Mobile/i.test(ua);
}

/**
 * The single decision used by auth.js: should this environment use redirect (vs popup) for
 * OAuth/redirect sign-in? True on any mobile UA, any detected Android WebView, OR when the native
 * shell explicitly flags itself (TM-231 can set `window.TEAMMARHABA_WEBVIEW = true` or inject the
 * `TeamMarhabaWebView` JS bridge — see docs/agents/webview-auth-contract).
 *
 * Pure given its inputs so it's unit-testable; auth.js calls `shouldUseRedirect()` (below) which
 * reads the live `navigator`/`window`.
 * @param {string} ua navigator.userAgent
 * @param {boolean} [explicitWebViewFlag=false] a native-shell-provided "I am a WebView" signal.
 * @returns {boolean}
 */
export function preferRedirect(ua, explicitWebViewFlag = false) {
  return Boolean(explicitWebViewFlag) || isMobileUserAgent(ua) || isAndroidWebViewUserAgent(ua);
}

/**
 * Read the explicit WebView signal from the global scope, if any. The TM-231 Android shell can set
 * either flag before the web app loads; both are honoured so the shell author can use whichever is
 * convenient (a window boolean via `addJavascriptInterface`/`evaluateJavascript`, or the presence of
 * the named JS bridge object).
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean}
 */
export function isWebViewEnv(win = globalThis) {
  if (!win) return false;
  return Boolean(win.TEAMMARHABA_WEBVIEW) || typeof win.TeamMarhabaWebView !== "undefined";
}

/**
 * Live convenience wrapper used by auth.js: reads the real `navigator.userAgent` + the WebView flag
 * and returns the redirect-vs-popup decision for the current environment.
 * @param {object} [win=globalThis] injectable for tests.
 * @returns {boolean} true → use signInWithRedirect; false → signInWithPopup.
 */
export function shouldUseRedirect(win = globalThis) {
  const ua = win && win.navigator ? win.navigator.userAgent : "";
  return preferRedirect(ua, isWebViewEnv(win));
}
