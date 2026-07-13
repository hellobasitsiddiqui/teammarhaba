package com.teammarhaba.backend.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * SMTP-specific tunables for the email-code mailer (TM-249), bound from
 * {@code app.auth.email-code.smtp.*}.
 *
 * <p>These are <strong>not secrets</strong> — the SMTP credentials themselves live under
 * {@code spring.mail.username} / {@code spring.mail.password} (from {@code MAIL_USERNAME} /
 * {@code MAIL_PASSWORD}) and are owned by Spring Boot's mail auto-configuration. This record only
 * carries the presentation/addressing knobs the {@link SmtpEmailCodeMailer} needs.
 *
 * <ul>
 *   <li>{@code enabled} — explicit on-switch for the SMTP mailer. Either this OR a configured
 *       {@code spring.mail.host} activates {@link SmtpEmailCodeMailer} (see its
 *       {@code @ConditionalOnProperty}); leaving both unset keeps the logging fallback (so dev/e2e
 *       work with no mail config). Defaults to {@code false}.</li>
 *   <li>{@code from} — the From address on the code email. Defaults to {@code no-reply@10xai.co.uk}
 *       (the decided sender domain, TM-249); override via {@code APP_MAIL_FROM} for another mailbox.
 *       </li>
 *   <li>{@code fromName} — optional display name shown alongside the From address.</li>
 * </ul>
 */
@ConfigurationProperties(prefix = "app.auth.email-code.smtp")
public record SmtpEmailCodeProperties(boolean enabled, String from, String fromName) {

    public SmtpEmailCodeProperties {
        if (from == null || from.isBlank()) {
            from = "no-reply@10xai.co.uk";
        }
        if (fromName == null || fromName.isBlank()) {
            fromName = "Circle";
        }
    }
}
