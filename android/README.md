# TeamMarhaba Android (WebView shell, direct APK) — TM-231

A thin **Kotlin WebView wrapper** around the hosted web UI (`https://teammarhaba.web.app`), shipped
as a **direct-download APK** — no Play Store, no Play Billing, no $25 account (all parked). It gives
phone users a native-feeling app while the real product stays the one responsive web codebase.

> **Build note:** this is a self-contained **Gradle (Kotlin DSL)** project. The backend uses Maven;
> this `android/` build is intentionally separate and is **not** part of any root build. There is **no
> Android CI** (the build sandbox has no Android SDK), so it is built locally / in a human Android env.

## What it does

| Capability | How |
|---|---|
| Loads the hosted app | Single `WebViewActivity` loads `BuildConfig.APP_URL` (`https://teammarhaba.web.app`). |
| Signals it's a WebView | Sets `window.TEAMMARHABA_WEBVIEW = true` at page start **and** injects the `TeamMarhabaWebView` JS bridge, so `auth-env.js` picks **redirect-mode** sign-in (a WebView has no popup). |
| Auth redirect completes | DOM storage + first-party & third-party cookies enabled; same-origin `/__/auth/**` (and the phone-auth reCAPTCHA round-trip) load **inside** the WebView and are never intercepted. |
| Avatar upload | `WebChromeClient.onShowFileChooser` wired to `<input id="profile-avatar-file" accept="image/*">`; honours the `accept` type, offers camera capture (CAMERA permission), and **always** resolves the callback (incl. `null` on cancel) so the input never wedges. |
| Back button | Hardware/gesture back navigates WebView history; exits when there's nothing to pop. |
| Offline page | Main-frame load failure swaps in a bundled `assets/offline.html` with a Retry button (reloads via the JS bridge). |
| Pull-to-refresh | `SwipeRefreshLayout` reloads the page (or the app, from the offline page). |
| Status bar / theme | Material3 DayNight theme follows the device light/dark setting. |
| Auto-update check | On launch, fetches the hosted `/assets/config.js`, parses `buildVersion`, and prompts to download if it differs from the installed `versionName`. |

The exact web-side contract this shell honours is **`docs/agents/webview-auth-contract.md`** — read it
before changing anything auth- or upload-related.

## Project layout

```
android/
├── settings.gradle.kts        # self-contained build; :app module
├── build.gradle.kts           # AGP 8.5.2 + Kotlin 1.9.24 (apply false)
├── gradle.properties          # AndroidX + the release-signing property contract (no secrets)
├── gradlew / gradlew.bat      # Gradle 8.7 wrapper
└── app/
    ├── build.gradle.kts       # app config + signing config (reads props/env, never secrets)
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/offline.html
        ├── java/app/teammarhaba/webview/
        │   ├── TeamMarhabaApp.kt        # Application
        │   ├── WebViewActivity.kt       # the single Activity — all WebView plumbing
        │   ├── TeamMarhabaJsBridge.kt   # window.TeamMarhabaWebView signal + reload hook
        │   └── UpdateChecker.kt         # lightweight auto-update check
        └── res/…                        # themes, strings, colors, launcher icon, xml config
```

## Build (debug)

Prerequisites: a JDK 17+ and the **Android SDK** (API 34). Point Gradle at the SDK either by setting
`ANDROID_HOME` or by creating `android/local.properties` (gitignored):

```
sdk.dir=/Users/<you>/Library/Android/sdk
```

Then:

```bash
cd android
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

Debug builds are signed with the auto-generated Android debug keystore — no secrets, installable for
testing. (Install on a device/emulator: `./gradlew installDebug`.)

> The CI sandbox that generated this project has **no Android SDK**, so `assembleDebug` there fails
> with `SDK location not found`. The Gradle/Kotlin config, manifest, and resources all **configure
> successfully** (`./gradlew :app:tasks` passes); compiling the APK just needs a real Android env.

## Signing & release

The release signing config in `app/build.gradle.kts` reads the keystore + passwords from Gradle
properties / env — **never committed**. Supply them one of three ways:

1. **User-global** `~/.gradle/gradle.properties` (outside the repo):
   ```properties
   teammarhaba.releaseStoreFile=/abs/path/teammarhaba-release.jks
   teammarhaba.releaseStorePassword=••••
   teammarhaba.releaseKeyAlias=teammarhaba
   teammarhaba.releaseKeyPassword=••••
   ```
2. **`-P` flags** on the command line (see below).
3. **Env vars** (CI): `ORG_GRADLE_PROJECT_teammarhaba.releaseStorePassword=••••`, etc.

A local `android/app/keystore.properties` (gitignored) with `storeFile/storePassword/keyAlias/keyPassword`
is also honoured for convenience.

### 1. Generate the keystore (once — then **guard it**)

```bash
keytool -genkeypair -v \
  -keystore teammarhaba-release.jks \
  -alias teammarhaba \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storetype JKS
```

> ⚠ **Custody is critical.** Losing this keystore (or its passwords) means you can **never ship an
> update** that the installed app will accept — Android refuses an APK signed by a different key, so
> users would have to uninstall + reinstall. **Back it up securely** (a password manager / secret
> vault, not the repo). Storing it and hosting the signed APK are **human/distribution steps** —
> see "Human steps remaining" below.

### 2. Build the signed release APK

```bash
cd android
./gradlew assembleRelease \
  -Pteammarhaba.releaseStoreFile=/abs/path/teammarhaba-release.jks \
  -Pteammarhaba.releaseStorePassword=••••   \
  -Pteammarhaba.releaseKeyAlias=teammarhaba \
  -Pteammarhaba.releaseKeyPassword=••••
# → app/build/outputs/apk/release/app-release.apk  (signed when props are present)
```

If the signing props are **absent**, `assembleRelease` still builds but produces an **unsigned** APK;
sign it manually afterwards:

```bash
$ANDROID_HOME/build-tools/34.0.0/apksigner sign \
  --ks teammarhaba-release.jks --ks-key-alias teammarhaba \
  --out app-release-signed.apk app/build/outputs/apk/release/app-release-unsigned.apk
$ANDROID_HOME/build-tools/34.0.0/apksigner verify app-release-signed.apk
```

### 3. Releasing — version stamping

The auto-update check compares the APK's `versionName` to the hosted web `buildVersion`. When you cut
a release APK, set `tmVersionName` in `app/build.gradle.kts` to **match the web `buildVersion`** it was
built from (e.g. the `git describe --tags` value live at `teammarhaba.web.app`), and bump `tmVersionCode`
(monotonic int) so Android treats the new APK as an upgrade on sideload. See "Auto-update check" below.

## Direct-APK distribution

There's no Play Store, so the signed APK is distributed as a **direct download**:

1. **Host the signed `app-release.apk`** at a stable URL and a **`/download`** landing page on the
   hosted site (the update prompt sends users to `https://teammarhaba.web.app/download`). Hosting the
   binary is a **human/distribution step** (see below) — this ticket wires the app to point there.
2. **Users install via "unknown sources":**
   - Tap the download link on the phone → the APK downloads.
   - Open it; Android prompts to allow installs from this source. Go to
     **Settings → Apps → Special access → Install unknown apps**, pick the browser/file app used to
     open the APK, and toggle **Allow from this source**.
   - Return and tap **Install**.
   - (On Android 8+ the permission is per-source; older devices have a single
     **Settings → Security → Unknown sources** toggle.)
3. **Updating:** the app checks on launch (below) and prompts; the user re-downloads the newer APK
   from `/download` and installs over the top (same signing key required).

## Auto-update check

`UpdateChecker` fetches the hosted **`/assets/config.js`** (always served by Firebase Hosting; the
deploy injects the live `buildVersion` into it — see `web/src/assets/config.js` +
`.github/workflows/deploy.yml`), parses `buildVersion` with a regex (no JS execution), and compares it
to the installed `versionName`.

- It runs on a background thread and **never throws** — any network/parse failure → no prompt (fail
  safe), so a flaky connection never blocks launch or nags the user.
- If the remote `buildVersion` is non-blank, not `"dev"`, and **differs** from the installed
  `versionName`, the app shows an "Update available" dialog → **Download** opens
  `https://teammarhaba.web.app/download` in the browser.
- **Contract:** stamp each release APK's `versionName` to equal the web `buildVersion` it was cut
  from (see "Releasing"). Then "remote ≠ installed" means a newer web build shipped after this APK —
  which is exactly when to prompt. This deliberately avoids cross-scheme semver parsing; a stricter
  monotonic comparison can replace it later without touching the call site.

## Human steps remaining (distribution / custody — not codeable here)

1. **Production keystore custody** — generate `teammarhaba-release.jks` (command above), store it +
   its passwords in a secret vault, and supply them at build time via the property/env contract.
   **Never commit it.** Losing it blocks all future updates.
2. **Host the signed APK + a `/download` landing page** — publish `app-release.apk` at a stable URL
   and add the `/download` page on `teammarhaba.web.app` the update prompt links to.
3. **User-facing "allow unknown sources" doc** — surface the install steps above to end users
   (e.g. on the `/download` page).
4. **Real-device manual test (TM-237)** — install the APK on a real device and verify sign-in
   (email-code + SMS), avatar upload, back/offline/refresh, and the update prompt.

## Parked (separate tickets)

Play Store listing + the $25 account + data-safety forms (future `human` ticket), FCM push, iOS, and
in-app payments are all out of scope for TM-231.
