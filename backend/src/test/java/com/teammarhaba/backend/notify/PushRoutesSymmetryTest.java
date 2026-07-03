package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
 *
 * <p>Since TM-394 there is additionally one allow-listed route <em>pattern</em> — the event-detail
 * deep link {@code #/events/{id}} — pinned here too: it is server-built only
 * ({@link PushRoutes#eventDetail}), accepted by the message-level {@link PushRoutes#isAllowed}
 * guard, and deliberately NOT part of {@code KNOWN} (so the admin picker/validation and the JS
 * set-symmetry above are untouched). The client does not resolve the pattern yet; until the events
 * web view mirrors it, a tap falls back to the client's default route by design.
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

    @Test
    void eventDetailBuilderEmitsThePatternShape() {
        assertThat(PushRoutes.eventDetail(42L)).isEqualTo("#/events/42");
        assertThat(PushRoutes.isEventDetail(PushRoutes.eventDetail(1L))).isTrue();
        assertThat(PushRoutes.isEventDetail(PushRoutes.eventDetail(Long.MAX_VALUE))).isTrue();
    }

    @Test
    void eventDetailBuilderRejectsNonPositiveIds() {
        assertThatThrownBy(() -> PushRoutes.eventDetail(0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PushRoutes.eventDetail(-7)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void isAllowedIsKnownPlusTheEventDetailPattern() {
        for (String route : PushRoutes.KNOWN) {
            assertThat(PushRoutes.isAllowed(route)).isTrue();
        }
        assertThat(PushRoutes.isAllowed("#/events/42")).isTrue();
        assertThat(PushRoutes.isAllowed(null)).isFalse();
        assertThat(PushRoutes.isAllowed("#/secret")).isFalse();
    }

    @Test
    void theEventDetailPatternMatchesExactlyServerBuiltIds() {
        // Whole-string, positive decimal Long ids only — nothing crafted can ride the pattern.
        assertThat(PushRoutes.isEventDetail("#/events/7")).isTrue();
        assertThat(PushRoutes.isEventDetail("#/events/" + Long.MAX_VALUE)).isTrue(); // 19 digits ok

        assertThat(PushRoutes.isEventDetail("#/events")).isFalse(); // the unbuilt bare view
        assertThat(PushRoutes.isEventDetail("#/events/")).isFalse();
        assertThat(PushRoutes.isEventDetail("#/events/0")).isFalse(); // ids are positive
        assertThat(PushRoutes.isEventDetail("#/events/01")).isFalse(); // no leading zero
        assertThat(PushRoutes.isEventDetail("#/events/-3")).isFalse();
        assertThat(PushRoutes.isEventDetail("#/events/12x")).isFalse();
        assertThat(PushRoutes.isEventDetail("#/events/1/edit")).isFalse(); // no trailing segments
        assertThat(PushRoutes.isEventDetail("#/events/12345678901234567890")).isFalse(); // 20 digits
        assertThat(PushRoutes.isEventDetail("https://evil.example/#/events/1")).isFalse();
        assertThat(PushRoutes.isEventDetail(null)).isFalse();
    }

    @Test
    void adminFacingValidationStaysStrictlyTheExactSet() {
        // isKnown (what broadcast/test-push validate admin input with, and what the picker lists)
        // must NOT accept pattern routes — the pattern is for server-built messages only.
        assertThat(PushRoutes.isKnown("#/events/42")).isFalse();
    }
}
