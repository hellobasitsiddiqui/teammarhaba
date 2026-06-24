package app.teammarhaba.webview

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Lightweight auto-update check (TM-231).
 *
 * A sideloaded APK gets no Play Store "update available" nudge, so we provide our own: on launch we
 * fetch a SMALL version source and compare it to the installed app's versionName. If they differ
 * (and the remote looks newer / simply different), the Activity prompts the user to download the
 * latest APK.
 *
 * ## Version source — why config.js
 * Firebase Hosting always serves `/assets/config.js`, and the deploy injects the live web build name
 * into it (`buildVersion: "<git describe --tags>"`, see web/src/assets/config.js +
 * .github/workflows/deploy.yml). That file is tiny (~1 KB) and needs no new backend endpoint, so it
 * is the cheapest authoritative "what's live" signal. We parse `buildVersion` out of it with a regex
 * rather than executing JS.
 *
 * ## Comparison strategy (deliberately simple + safe)
 * Web `buildVersion` (e.g. `v1.4.0-12-ged338a9`) and the native `versionName` (e.g. `1.0.0`) are NOT
 * the same numbering scheme, so we do not try to parse semver across them. Instead the contract is:
 * the release process stamps the APK's `versionName` to MATCH the web `buildVersion` it was cut
 * from (documented in android/README "Releasing"). Then "remote != installed && remote non-blank"
 * means a newer web build shipped after this APK — prompt to update. This never false-positives on a
 * matching build and fails safe (no prompt) on any fetch/parse error. A stricter monotonic check can
 * replace this later without changing the call site.
 */
object UpdateChecker {

    /** Result of a single check. [updateAvailable] gates the prompt; the versions feed the dialog. */
    data class Result(
        val updateAvailable: Boolean,
        val installedVersion: String,
        val latestVersion: String?,
    )

    // Matches `buildVersion: "…"` (single or double quotes) in the hosted config.js.
    private val BUILD_VERSION_REGEX = Regex("""buildVersion\s*:\s*["']([^"']+)["']""")

    /**
     * Fetch the hosted config.js and decide whether an update is available. Runs the network call on
     * the IO dispatcher; never throws — any failure yields [Result.updateAvailable] = false so a flaky
     * network or a parsing miss never blocks app launch or nags the user.
     *
     * @param appUrl the hosted origin (BuildConfig.APP_URL), e.g. https://teammarhaba.web.app
     * @param installedVersion BuildConfig.VERSION_NAME of the running APK
     */
    suspend fun check(appUrl: String, installedVersion: String): Result =
        withContext(Dispatchers.IO) {
            val latest = fetchLatestVersion(appUrl)
            val available = latest != null &&
                latest.isNotBlank() &&
                latest != "dev" &&            // unconfigured local build — never prompt against it
                latest != installedVersion
            Result(
                updateAvailable = available,
                installedVersion = installedVersion,
                latestVersion = latest,
            )
        }

    private fun fetchLatestVersion(appUrl: String): String? {
        val url = "${appUrl.trimEnd('/')}/assets/config.js"
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 5000
                readTimeout = 5000
                requestMethod = "GET"
                setRequestProperty("Accept", "application/javascript, text/plain, */*")
            }
            if (conn.responseCode != HttpURLConnection.HTTP_OK) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            BUILD_VERSION_REGEX.find(body)?.groupValues?.getOrNull(1)
        } catch (_: Exception) {
            null // fail safe — no prompt on any network/parse error
        } finally {
            conn?.disconnect()
        }
    }
}
