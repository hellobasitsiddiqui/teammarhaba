package com.teammarhaba.backend.auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.mail.javamail.JavaMailSender;

/**
 * Wires the real SMTP login-code mailer (TM-249), but only when mail is actually configured.
 *
 * <p><strong>Activation.</strong> The {@link SmtpEmailCodeMailer} bean is registered when EITHER
 * {@code app.auth.email-code.smtp.enabled=true} OR {@code spring.mail.host} is set. Both signals are
 * ORed in a single {@code @ConditionalOnExpression} (the same idiom the emulator seam uses), so the
 * factory method is the one place the "mail is configured" decision lives. When neither is set, no
 * bean is registered here, so the default {@link LoggingEmailCodeMailer}
 * ({@code @ConditionalOnMissingBean} in {@link EmailCodeMailerConfig}) ships and dev/test/CI/e2e boot
 * with no mail config and no SMTP connection.
 *
 * <p><strong>Why {@code @Primary} (TM-269).</strong> When mail IS configured this bean is supposed to
 * win and the logging default's {@code @ConditionalOnMissingBean} is supposed to back off — but that
 * backoff depends on bean-definition <em>ordering</em>, and in the full application context (component
 * scan + auto-config) the ordering let BOTH beans register, so {@link EmailCodeService} (which injects
 * a single {@link EmailCodeMailer}) failed at startup with "expected single matching bean but found 2"
 * → the container never came up → the Cloud Run startup probe failed → the deploy aborted in prod.
 * CI/dev/e2e never caught it because they run with mail OFF (only the logging bean exists). Marking
 * the SMTP mailer {@code @Primary} makes it the unambiguous injection target whenever both beans are
 * present, so a single-{@code EmailCodeMailer} consumer resolves deterministically regardless of
 * definition order. The emulator's {@code @Primary} recorder still outranks both under the emulator,
 * and since mail is OFF under the emulator no {@code smtpEmailCodeMailer} exists there — so the two
 * {@code @Primary} mailers never coexist and the e2e peek path is unaffected.
 *
 * <p>Credentials come from {@code spring.mail.username} / {@code spring.mail.password}
 * ({@code MAIL_USERNAME} / {@code MAIL_PASSWORD}); the mailer's constructor fails loud if either is
 * blank while mail is enabled.
 */
@Configuration
@EnableConfigurationProperties(SmtpEmailCodeProperties.class)
public class SmtpEmailCodeMailerConfig {

    /** Either an explicit smtp.enabled flag, or a configured spring.mail.host, turns the mailer on. */
    static final String MAIL_CONFIGURED =
            "${app.auth.email-code.smtp.enabled:false} or ('${spring.mail.host:}' != '')";

    @Bean
    @Primary
    @ConditionalOnExpression(MAIL_CONFIGURED)
    EmailCodeMailer smtpEmailCodeMailer(
            JavaMailSender mailSender,
            SmtpEmailCodeProperties props,
            @Value("${spring.mail.username:}") String username,
            @Value("${spring.mail.password:}") String password) {
        return new SmtpEmailCodeMailer(mailSender, props, username, password);
    }
}
