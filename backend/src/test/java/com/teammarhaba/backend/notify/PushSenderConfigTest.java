package com.teammarhaba.backend.notify;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.google.firebase.messaging.FirebaseMessaging;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Verifies the {@link PushSender} bean wiring (TM-284), mirroring the mailer-seam wiring test: the real
 * {@link FcmPushSender} ships by default (so production sends over FCM), and a custom {@link PushSender}
 * bean wins via {@code @ConditionalOnMissingBean} (so a test or future transport can swap it out without
 * touching {@link PushNotificationService}). A stub {@link FirebaseMessaging} stands in — no real SDK.
 */
class PushSenderConfigTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withUserConfiguration(StubMessagingConfig.class, PushSenderConfig.class);

    @Test
    void defaultsToFcmPushSender() {
        runner.run(context -> {
            assertThat(context).hasSingleBean(PushSender.class);
            assertThat(context.getBean(PushSender.class)).isInstanceOf(FcmPushSender.class);
        });
    }

    @Test
    void customSenderBeanOverridesTheDefault() {
        PushSender custom = (token, message) -> PushDelivery.DELIVERED;
        // Register the custom sender as an existing bean so @ConditionalOnMissingBean sees it and the
        // FcmPushSender default deterministically backs off (no definition-ordering dependence).
        new ApplicationContextRunner()
                .withBean(PushSender.class, () -> custom)
                .withUserConfiguration(StubMessagingConfig.class, PushSenderConfig.class)
                .run(context -> {
                    assertThat(context).hasSingleBean(PushSender.class);
                    assertThat(context.getBean(PushSender.class)).isSameAs(custom);
                });
    }

    @Configuration
    static class StubMessagingConfig {
        @Bean
        FirebaseMessaging firebaseMessaging() {
            return mock(FirebaseMessaging.class);
        }
    }
}
