import java.util.Properties

// TeamMarhaba Android WebView shell — :app module (TM-231).
//
// A thin Kotlin WebView wrapper around the hosted web UI (https://teammarhaba.web.app), shipped as a
// direct APK (no Play Store). See android/README.md for build/sign/distribute docs and
// docs/agents/webview-auth-contract.md for the auth/upload contract this shell must honour.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---- App version --------------------------------------------------------------------------------
// versionName is the human-readable app version shown to users and compared by the auto-update check
// against the hosted web `buildVersion`. Bump versionCode (monotonic int) on every release you ship
// an APK for — Android uses it to decide "is this APK newer than the installed one" on sideload.
//
// Both are OVERRIDABLE at build time so the release CI (TM-246) can STAMP the APK's versionName to
// match the web `buildVersion` it was cut from — the exact contract UpdateChecker relies on (a
// `git describe --tags` value like `v1.4.0-12-ged338a9`). The release workflow passes:
//   -PtmVersionName="<web buildVersion>" -PtmVersionCode=<monotonic int>
// Falls back to the committed defaults for a plain local `assembleDebug` (no -P needed). versionCode
// must stay a positive int (Android requirement), so a non-numeric override is ignored.
val tmVersionName = (findProperty("tmVersionName") as String?)?.takeIf { it.isNotBlank() } ?: "1.0.0"
val tmVersionCode = (findProperty("tmVersionCode") as String?)?.toIntOrNull() ?: 1

// The hosted web origin the WebView loads, and the small version source the auto-update check reads.
// Centralised here so a single build config flips them (e.g. to a preview channel) with no code edit.
val tmAppUrl = "https://teammarhaba.web.app"

android {
    namespace = "app.teammarhaba.webview"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.teammarhaba.webview"
        minSdk = 24 // Android 7.0 — covers ~99% of active devices; modern WebView APIs available.
        targetSdk = 34
        versionCode = tmVersionCode
        versionName = tmVersionName

        // Surfaced to Kotlin via BuildConfig so the shell never hardcodes the URL/version inline.
        buildConfigField("String", "APP_URL", "\"$tmAppUrl\"")
        // The auto-update check fetches the hosted config.js and parses `buildVersion`; the version
        // source URL is derived from APP_URL at runtime (see UpdateChecker), so nothing else needed.
    }

    // ---- Signing ---------------------------------------------------------------------------------
    // Release signing reads the keystore + passwords from Gradle properties / env — NEVER committed
    // (see gradle.properties header + README "Signing & release"). If the props are absent (e.g. a
    // plain `assembleDebug` or a checkout without the keystore), the release signingConfig is simply
    // not attached, so the build still configures — `assembleRelease` then produces an UNSIGNED APK
    // that must be signed separately. This keeps the project buildable with zero secrets present.
    val keystoreProps = loadReleaseSigningProps()
    signingConfigs {
        if (keystoreProps != null) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
            // Debug builds are signed with the auto-generated Android debug keystore — no secrets.
        }
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // Attach the release signing config only when its props were supplied. Otherwise the
            // release APK is unsigned (sign it later with apksigner — see README).
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    // Pull-to-refresh around the WebView.
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    // Edge-to-edge / status-bar theming helpers.
    implementation("androidx.activity:activity-ktx:1.9.1")
    // Background version fetch off the main thread.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}

/**
 * Load the release signing properties from the first available source, WITHOUT ever committing them:
 *   1. -P Gradle properties (or ~/.gradle/gradle.properties / ORG_GRADLE_PROJECT_* env), keyed
 *      `teammarhaba.releaseStoreFile` / `…StorePassword` / `…KeyAlias` / `…KeyPassword`.
 *   2. A `keystore.properties` file next to this module (gitignored) for local convenience.
 * Returns null when nothing is configured, so debug builds and secret-free checkouts still work.
 */
fun loadReleaseSigningProps(): Properties? {
    fun prop(name: String): String? =
        (findProperty(name) as String?)?.takeIf { it.isNotBlank() }

    val storeFile = prop("teammarhaba.releaseStoreFile")
    if (storeFile != null) {
        return Properties().apply {
            setProperty("storeFile", storeFile)
            setProperty("storePassword", prop("teammarhaba.releaseStorePassword") ?: "")
            setProperty("keyAlias", prop("teammarhaba.releaseKeyAlias") ?: "")
            setProperty("keyPassword", prop("teammarhaba.releaseKeyPassword") ?: "")
        }
    }

    val localFile = rootProject.file("app/keystore.properties")
    if (localFile.exists()) {
        return Properties().apply { localFile.inputStream().use { load(it) } }
    }
    return null
}
