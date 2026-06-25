package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

/**
 * {@link PushMessage} construction guards. Title/body must be non-blank (TM-284), and the optional
 * deep-link {@code route} (TM-290) is constrained to the app's known hash routes — the last-line guard
 * that an off-allow-list route never reaches the FCM wire even if a caller forgets to pre-validate.
 */
class PushMessageTest {

    @Test
    void blankTitleOrBodyIsRejected() {
        assertThatThrownBy(() -> new PushMessage(" ", "body")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PushMessage("title", "")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aNullRouteMeansNoDeepLink() {
        assertThat(new PushMessage("t", "b").route()).isNull();
        assertThat(new PushMessage("t", "b", null).route()).isNull();
    }

    @Test
    void eachKnownRouteIsAccepted() {
        for (String route : PushRoutes.KNOWN) {
            assertThat(new PushMessage("t", "b", route).route()).isEqualTo(route);
        }
    }

    @Test
    void anUnknownRouteIsRejected() {
        // Off the allow-list, an external/scheme'd target, and a non-hash shape are all rejected — the
        // record only ever holds a known same-app hash route (matches push-deeplink.js, TM-285).
        assertThatThrownBy(() -> new PushMessage("t", "b", "#/secret"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PushMessage("t", "b", "https://evil.example/"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PushMessage("t", "b", "/profile"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
