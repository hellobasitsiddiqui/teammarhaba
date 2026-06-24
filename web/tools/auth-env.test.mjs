// Tests for the auth environment detection (TM-230). Framework-free — Node's built-in test runner,
// same harness as fingerprint.test.mjs and picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// Guards the core TM-230 contract that CANNOT be reproduced in an emulator: that mobile browsers and
// Android WebViews choose `signInWithRedirect`, while desktop keeps `signInWithPopup`. The auth.js
// call sites are thin wrappers around this decision, so testing the decision tests the behaviour.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isMobileUserAgent,
  isAndroidWebViewUserAgent,
  preferRedirect,
  isWebViewEnv,
  shouldUseRedirect,
} from "../src/assets/auth-env.js";

// Representative real-world user-agent strings.
const UA = {
  desktopChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  desktopFirefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  androidWebView:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36",
};

test("desktop browsers are not detected as mobile", () => {
  assert.equal(isMobileUserAgent(UA.desktopChrome), false);
  assert.equal(isMobileUserAgent(UA.desktopFirefox), false);
});

test("phone and tablet browsers are detected as mobile", () => {
  assert.equal(isMobileUserAgent(UA.androidChrome), true);
  assert.equal(isMobileUserAgent(UA.iphoneSafari), true);
  assert.equal(isMobileUserAgent(UA.ipadSafari), true);
});

test("the Android WebView (;wv) marker is detected", () => {
  assert.equal(isAndroidWebViewUserAgent(UA.androidWebView), true);
  // Standalone Android Chrome (no wv, no Version/ token) is NOT a WebView.
  assert.equal(isAndroidWebViewUserAgent(UA.androidChrome), false);
  assert.equal(isAndroidWebViewUserAgent(UA.desktopChrome), false);
});

test("preferRedirect: redirect on mobile + WebView, popup on desktop", () => {
  // Desktop → popup (false).
  assert.equal(preferRedirect(UA.desktopChrome), false);
  assert.equal(preferRedirect(UA.desktopFirefox), false);
  // Mobile + WebView → redirect (true).
  assert.equal(preferRedirect(UA.androidChrome), true);
  assert.equal(preferRedirect(UA.iphoneSafari), true);
  assert.equal(preferRedirect(UA.androidWebView), true);
});

test("an explicit native-shell WebView flag forces redirect even on a desktop-looking UA", () => {
  // iOS WKWebView can't be detected from the UA, so the shell flags itself; honour that.
  assert.equal(preferRedirect(UA.desktopChrome, false), false);
  assert.equal(preferRedirect(UA.desktopChrome, true), true);
});

test("isWebViewEnv reads either native-shell signal", () => {
  assert.equal(isWebViewEnv({}), false);
  assert.equal(isWebViewEnv({ TEAMMARHABA_WEBVIEW: true }), true);
  assert.equal(isWebViewEnv({ TeamMarhabaWebView: {} }), true);
  // A falsy flag is still false.
  assert.equal(isWebViewEnv({ TEAMMARHABA_WEBVIEW: false }), false);
});

test("shouldUseRedirect reads the live navigator + WebView flag", () => {
  assert.equal(shouldUseRedirect({ navigator: { userAgent: UA.desktopChrome } }), false);
  assert.equal(shouldUseRedirect({ navigator: { userAgent: UA.androidChrome } }), true);
  // Desktop UA but the shell flags WebView → redirect.
  assert.equal(
    shouldUseRedirect({ navigator: { userAgent: UA.desktopChrome }, TEAMMARHABA_WEBVIEW: true }),
    true,
  );
  // No navigator at all → safe default (popup).
  assert.equal(shouldUseRedirect({}), false);
});

test("malformed inputs never throw and default to non-mobile/popup", () => {
  assert.equal(isMobileUserAgent(undefined), false);
  assert.equal(isMobileUserAgent(null), false);
  assert.equal(isMobileUserAgent(123), false);
  assert.equal(isAndroidWebViewUserAgent(undefined), false);
  assert.equal(preferRedirect(""), false);
  assert.equal(isWebViewEnv(null), false);
});
