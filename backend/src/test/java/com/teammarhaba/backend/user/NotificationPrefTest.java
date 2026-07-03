package com.teammarhaba.backend.user;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The {@link NotificationPref} model (TM-427). {@code permitsPush()} is the single source of truth for
 * "would a push reach this preference?" — shared by the admin broadcast opt-out rail and the admin
 * push-eligibility signal, so the UI's "can receive push" check and the server's skip can't drift.
 */
class NotificationPrefTest {

    @Test
    void pushAndBothPermitPush() {
        assertThat(NotificationPref.PUSH.permitsPush()).isTrue();
        assertThat(NotificationPref.BOTH.permitsPush()).isTrue();
    }

    @Test
    void emailIsThePushOptOut() {
        assertThat(NotificationPref.EMAIL.permitsPush()).isFalse();
    }
}
