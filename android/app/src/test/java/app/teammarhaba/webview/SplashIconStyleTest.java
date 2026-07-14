package app.teammarhaba.webview;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

/**
 * Cheap config-regression guard for TM-664 (splash shows a plain teal box, no logo).
 *
 * <p>Reads the res source files directly (no Robolectric, no Android runtime) and asserts the launch
 * splash points its {@code windowSplashScreenAnimatedIcon} at the DEDICATED {@code @drawable/splash_icon}
 * — a foreground-only white ring on transparent — and NOT back at {@code @mipmap/ic_launcher}. The
 * launcher icon is a white ring on the SAME teal as {@code windowSplashScreenBackground}, so the
 * Android-12 splash (which discards the icon background and masks to a tighter circle) rendered it as
 * a plain teal box. This FAILS {@code :app:test} if either regression returns.
 *
 * <p>Paths are resolved RELATIVE to the module/project dir (never hardcoded absolute), walking up a
 * few parents so it works whether user.dir is android/app, android, or the repo root — same approach
 * as {@link PortraitLockManifestTest}.
 */
public class SplashIconStyleTest {

    private static final String STYLES_RELATIVE_PATH = "src/main/res/values/styles.xml";
    private static final String SPLASH_ICON_RELATIVE_PATH = "src/main/res/drawable/splash_icon.xml";

    private File locate(String relative) {
        File dir = new File(System.getProperty("user.dir", "."));
        for (int i = 0; i < 4 && dir != null; i++) {
            File candidate = new File(dir, relative);
            if (candidate.isFile()) {
                return candidate;
            }
            File appCandidate = new File(dir, "app/" + relative);
            if (appCandidate.isFile()) {
                return appCandidate;
            }
            File androidAppCandidate = new File(dir, "android/app/" + relative);
            if (androidAppCandidate.isFile()) {
                return androidAppCandidate;
            }
            dir = dir.getParentFile();
        }
        return null;
    }

    @Test
    public void splashUsesDedicatedIconNotLauncher() throws IOException {
        File styles = locate(STYLES_RELATIVE_PATH);
        if (styles == null) {
            fail("Could not locate styles.xml relative to user.dir=" + System.getProperty("user.dir"));
        }
        String contents = new String(Files.readAllBytes(styles.toPath()), StandardCharsets.UTF_8);

        assertTrue(
            "Splash icon regressed: expected windowSplashScreenAnimatedIcon=\"@drawable/splash_icon\" in "
                + styles.getAbsolutePath()
                + ". Do not point the splash at the launcher icon (TM-664 teal-on-teal box).",
            contents.contains(
                "<item name=\"windowSplashScreenAnimatedIcon\">@drawable/splash_icon</item>"));

        assertFalse(
            "Splash icon must not be @mipmap/ic_launcher — its white ring is clipped and blends into"
                + " the same-teal splash background, showing a plain box (TM-664).",
            contents.contains(
                "<item name=\"windowSplashScreenAnimatedIcon\">@mipmap/ic_launcher</item>"));
    }

    @Test
    public void dedicatedSplashIconExists() {
        File splashIcon = locate(SPLASH_ICON_RELATIVE_PATH);
        assertTrue(
            "Missing res/drawable/splash_icon.xml — the dedicated white-ring splash icon (TM-664).",
            splashIcon != null && splashIcon.isFile());
    }
}
