# Mobile / WebView auth hardening — web-side done + the TM-231 native contract (TM-230)

This is the authoritative hand-off for **TM-230** (mobile/WebView Firebase auth hardening). It records
what is implemented on the **web + Firebase Hosting** side now, and the exact contract the later
**TM-231** Android WebView shell must satisfy. The `android/` and `webview/` dirs are still stubs by
design — TM-230 does **not** build an APK.

## What changed on the web (TM-230)

| Area | Change | File |
|---|---|---|
| Redirect vs popup | OAuth sign-in uses `signInWithRedirect` on mobile + WebView, keeps `signInWithPopup` on desktop | `web/src/assets/auth.js` (`signInWithGoogle`) |
| Detection | Pure, unit-tested mobile/WebView detection | `web/src/assets/auth-env.js` (+ `web/tools/auth-env.test.mjs`) |
| Redirect completion | `getRedirectResult` reclaimed on load; failures surfaced inline (not silent) | `web/src/assets/auth.js` (`awaitRedirectResult`), `web/src/assets/login.js` |
| First-party auth handler | `authDomain` → our own Hosting origin so `/__/auth/**` is first-party | `web/src/assets/firebase-config.js` |

### First-party auth handler — the actual exposure

`authDomain` is now `teammarhaba.web.app` (our Hosting origin), not the default
`teammarhaba.firebaseapp.com`. Firebase Hosting **reserves and auto-serves** the `/__/auth/**` and
`/__/firebase/**` handler paths on every Hosting site, and matches them **before** user rewrites — so
the `**` → `/index.html` SPA rewrite in `firebase.json` never swallows them and **no extra rewrite is
needed**. (Do **not** add a `/__/auth/**` rewrite — it would override the reserved handler and break
the redirect flow.)

Serving the handler from the same origin the app runs on makes the redirect / reCAPTCHA round-trip
**first-party**, so Safari ITP and Chrome third-party-cookie/storage blocking can't strand it with the
`auth/missing-initial-state` ("Missing initial state") error.

**Who is actually exposed to this:**
- **Parked social / OAuth (Google, TM-200)** — `signInWithRedirect` does a full cross-document
  round-trip through the handler. This is the flow that genuinely needs the first-party handler.
- **Phone-auth reCAPTCHA fallback** — a sideloaded APK has no Play Integrity, so Firebase phone-auth
  falls back to the web reCAPTCHA path, which redirects to `…/__/auth/handler` and back (see the
  TM-230 scope-note comment, and TM-241 which enabled the provider + the `+16505550100`→`123456` test
  number). First-party handler keeps that redirect from stranding inside the WebView.
- **Email-code (custom token) and SMS `.confirm(code)`** — **no redirect, no third-party cookies**.
  These were already robust; the hardening doesn't change them. This is the real, narrow exposure
  surface: only the redirect-based providers above.

## The TM-231 Android WebView shell contract

TM-231 builds the native shell. To make auth + avatar upload work inside it, the shell **must**:

### 1. Signal that it's a WebView
The web decides redirect-vs-popup from the UA, but iOS WKWebView (and some Android WebViews) don't
advertise themselves reliably. Belt-and-braces: have the shell set **either** signal before/at page
load, and `web/src/assets/auth-env.js#isWebViewEnv` will honour it:
- `window.TEAMMARHABA_WEBVIEW = true`, **or**
- inject a JS bridge object named `TeamMarhabaWebView` (via `addJavascriptInterface`).

Android System WebView UAs carry `; wv)` and are already detected without this, but setting the flag
makes it deterministic and covers iOS if a shell is ever added.

### 2. Let the redirect handler navigate (don't trap `/__/auth/**`)
`signInWithRedirect` and the reCAPTCHA fallback navigate to `https://teammarhaba.web.app/__/auth/...`
and back. The WebView must:
- **Allow** those navigations (don't intercept `shouldOverrideUrlLoading` for same-origin
  `teammarhaba.web.app` URLs — let the WebView load them).
- Keep **DOM storage + cookies enabled** (`WebSettings.setDomStorageEnabled(true)`; accept first-party
  cookies). Firebase persists the redirect "initial state" in web storage; disabling it reproduces the
  "Missing initial state" failure even with a first-party handler.
- Not clear storage between the outbound redirect and the return.

### 3. Phone-auth = reCAPTCHA fallback (no Play Integrity)
A direct/sideloaded APK isn't a Play install, so Firebase phone-auth uses the **web reCAPTCHA
fallback**, not Play Integrity / SafetyNet. That's expected and already what the web SDK path
(`startPhoneSignIn` in `auth.js`) uses. The shell just has to let the reCAPTCHA `__/auth/handler`
redirect complete (point 2). Verify with the TM-241 test number `+16505550100` → `123456` (no real
SMS, no quota burn).

### 4. `onShowFileChooser` for avatar upload
The avatar upload is a standard HTML file input the WebView must service via
`WebChromeClient.onShowFileChooser`. **Exact contract of the web input:**
- Element id: **`profile-avatar-file`** (`web/src/assets/profile.js`).
- `type="file"`, **`accept="image/*"`** — honour the accept type when building the chooser
  (gallery + camera for images).
- Single file (no `multiple`).
- The shell must call `filePathCallback.onReceiveValue(...)` with the picked URI(s), or
  `onReceiveValue(null)` on cancel — **never drop the callback**, or the input wedges and a retry
  can't reopen the chooser.
- Camera capture needs `CAMERA` + storage/media permissions on the Android side; request them before
  invoking the callback.

Without `onShowFileChooser` wired, tapping the avatar input inside a WebView does nothing — the input
is correct on the web side; the chooser is purely an Android-side hook.

## Residual real-device checks (→ human manual-test ticket TM-237)
Emulators don't reproduce Safari ITP, Chrome third-party-cookie blocking, or Play-Integrity-vs-reCAPTCHA
behaviour, so these stay as **human** real-device checks:
- Real iOS Safari + Android Chrome: Google redirect sign-in completes and returns signed-in (once
  TM-200 un-parks the provider).
- Real-device phone-auth via the reCAPTCHA fallback (test number) completes the `__/auth/handler`
  round-trip and returns into the app.
- Once TM-231 ships an APK: email-code + SMS sign-in and avatar upload inside the WebView.
