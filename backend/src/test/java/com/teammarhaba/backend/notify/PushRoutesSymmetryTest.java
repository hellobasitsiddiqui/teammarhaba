package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Pins the backend deep-link allow-list {@link PushRoutes#KNOWN} to its exact v1 membership (TM-360,
 * epic TM-358).
 *
 * <p>The allow-list is hand-maintained in two places that must stay byte-identical: this Java
 * {@code KNOWN} set (what a push/broadcast may emit, and the single source of truth the admin compose
 * picker now populates from) and the client {@code KNOWN_ROUTES} in
 * {@code web/src/assets/push-deeplink.js} (what a tap can navigate to). The primary cross-language
 * symmetry check parses this constant from the JS side in {@code web/tools/push-deeplink.test.mjs}
 * (the fast Node PR gate); this test is the mirror pin so a <em>backend-only</em> edit is also caught
 * here in the backend gate. If you intentionally add or remove a route, update BOTH lists <em>and</em>
 * this expectation together — that deliberate three-way edit is exactly the review checkpoint.
 *
 * <p>Also asserts the two app-only router views ({@code #/terms}, {@code #/diagnostics}) and the
 * not-yet-existent {@code #/events} view are NOT push targets, so none creeps onto the allow-list.
 */
class PushRoutesSymmetryTest {

    /** The exact v1 deep-link allow-list — must match client {@code KNOWN_ROUTES} (TM-360). */
    private static final Set<String> EXPECTED_V1 =
            Set.of("#/home", "#/profile", "#/admin", "#/help", "#/onboarding", "#/login");

    @Test
    void knownIsExactlyTheSixV1Routes() {
        assertThat(PushRoutes.KNOWN)
                .as("backend deep-link allow-list must be the exact v1 set (keep in lock-step with "
                        + "web/src/assets/push-deeplink.js KNOWN_ROUTES — TM-360)")
                .containsExactlyInAnyOrderElementsOf(EXPECTED_V1);
    }

    @Test
    void appOnlyAndUnbuiltRoutesAreNotPushTargets() {
        // Router has these views but they are deliberately not push deep-link destinations; #/events
        // does not exist in v1 at all. Guard against any of them being added to the allow-list.
        assertThat(PushRoutes.KNOWN).doesNotContain("#/terms", "#/diagnostics", "#/events");
        assertThat(PushRoutes.isKnown("#/events")).isFalse();
    }
}
