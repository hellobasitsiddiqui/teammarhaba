package com.teammarhaba.backend.auth;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
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
 * with no mail config and no SMTP connection. When this bean IS present it wins over the logging
 * default (which backs off). The emulator's {@code @Primary} recorder still outranks both under the
 * emulator, so the e2e peek path is unaffected.
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
    @ConditionalOnExpression(MAIL_CONFIGURED)
    EmailCodeMailer smtpEmailCodeMailer(
            JavaMailSender mailSender,
            SmtpEmailCodeProperties props,
            @Value("${spring.mail.username:}") String username,
            @Value("${spring.mail.password:}") String password) {
        return new SmtpEmailCodeMailer(mailSender, props, username, password);
    }
}
