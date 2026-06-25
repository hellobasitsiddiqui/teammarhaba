package com.teammarhaba.backend.notify;

import com.google.firebase.messaging.FirebaseMessaging;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Lazy;

/**
 * Wires the default push transport (TM-284): the real {@link FcmPushSender} ships unless another
 * {@link PushSender} bean is present, mirroring the {@code EmailCodeMailer} seam. A test registers a
 * recording {@link PushSender} so it wins and no real FCM is called; a future transport swaps in the
 * same way — this default backs off automatically, with no edit here.
 *
 * <p>{@code @ConditionalOnMissingBean} is on a {@code @Bean} factory method (not a component-scanned
 * {@code @Component}) so the condition is evaluated after user-defined beans are known — the reliable
 * "default unless overridden" idiom (same as {@code EmailCodeMailerConfig}).
 *
 * <p>The injected {@link FirebaseMessaging} is the {@link Lazy} bean from {@code FirebaseConfig}, so
 * dev/test/CI never initialise the Admin SDK just by having this default present — initialisation is
 * deferred until an actual push is sent.
 */
@Configuration
public class PushSenderConfig {

    @Bean
    @ConditionalOnMissingBean(PushSender.class)
    PushSender fcmPushSender(@Lazy FirebaseMessaging messaging) {
        return new FcmPushSender(messaging);
    }
}
