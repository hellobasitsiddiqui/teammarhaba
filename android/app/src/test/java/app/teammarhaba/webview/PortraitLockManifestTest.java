package app.teammarhaba.webview;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

/**
 * Cheap config-regression guard for TM-667 (portrait lock).
 *
 * <p>Reads the AndroidManifest.xml source file directly (no Robolectric, no Android runtime) and
 * asserts the MainActivity is locked to {@code android:screenOrientation="userPortrait"}. This FAILS
 * the {@code :app:test} task if the portrait lock is ever removed, so the AC-1 device behaviour
 * can't silently regress.
 *
 * <p>The manifest path is resolved RELATIVE to the module/project dir (never hardcoded absolute):
 * Gradle runs unit tests with {@code user.dir} set to the module dir, but we also walk up a couple
 * of parents so the test still finds the manifest if run from the repo root or the android/ dir.
 */
public class PortraitLockManifestTest {

    private static final String MANIFEST_RELATIVE_PATH = "src/main/AndroidManifest.xml";

    private File locateManifest() {
        File dir = new File(System.getProperty("user.dir", "."));
        // Walk up a few levels so this works whether user.dir is android/app, android, or repo root.
        for (int i = 0; i < 4 && dir != null; i++) {
            File candidate = new File(dir, MANIFEST_RELATIVE_PATH);
            if (candidate.isFile()) {
                return candidate;
            }
            // Also try the app module explicitly (e.g. when user.dir is the repo root or android/).
            File appCandidate = new File(dir, "app/" + MANIFEST_RELATIVE_PATH);
            if (appCandidate.isFile()) {
                return appCandidate;
            }
            File androidAppCandidate = new File(dir, "android/app/" + MANIFEST_RELATIVE_PATH);
            if (androidAppCandidate.isFile()) {
                return androidAppCandidate;
            }
            dir = dir.getParentFile();
        }
        return null;
    }

    @Test
    public void mainActivityIsLockedToUserPortrait() throws IOException {
        File manifest = locateManifest();
        if (manifest == null) {
            fail(
                "Could not locate AndroidManifest.xml relative to user.dir="
                    + System.getProperty("user.dir"));
        }

        String contents = new String(Files.readAllBytes(manifest.toPath()), StandardCharsets.UTF_8);

        // The MainActivity must be locked to strict `portrait` (TM-667). userPortrait did NOT hold on
        // device/emulator (it's sensor/user-preference based, so the app still rotated to landscape);
        // strict `portrait` is a hard lock the window manager enforces regardless of sensor/user.
        assertTrue(
            "Portrait lock missing: expected android:screenOrientation=\"portrait\" in "
                + manifest.getAbsolutePath()
                + ". Do not remove the TM-667 portrait lock.",
            contents.contains("android:screenOrientation=\"portrait\""));
    }
}
