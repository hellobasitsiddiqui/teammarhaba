package com.teammarhaba.backend.auth;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Configuration for the real SendGrid login-code transport (TM-249), bound from
 * {@code app.auth.email-code.sendgrid.*}.
 *
 * <p>The {@link #apiKey()} is the <strong>only secret</strong> here (sourced from
 * {@code SENDGRID_API_KEY} via the environment / Secret Manager — never committed). Its presence is
 * what switches the app from the dev/e2e {@link LoggingEmailCodeMailer} stub to a real send: the
 * {@link SendGridEmailCodeMailer} bean is gated on a <em>non-blank</em>
 * {@code app.auth.email-code.sendgrid.api-key} (see {@link EmailCodeMailerConfig}).
 *
 * <p><strong>Why no {@code @NotBlank} here.</strong> This type is picked up by the app-wide
 * {@code @ConfigurationPropertiesScan}, so it is bound + validated in <em>every</em> environment.
 * The base config defaults the key to {@code ${SENDGRID_API_KEY:}} (empty) so dev/test/CI/e2e need
 * no provider — a {@code @NotBlank} would therefore crash those environments at startup. Instead the
 * key is allowed to bind blank (≡ "no provider, use the logging stub"), and {@link
 * EmailCodeMailerConfig} enforces fail-loud: the SendGrid bean is built only when the key is
 * non-blank, and its factory rejects a blank key defensively — so a half-configured prod that
 * intends SendGrid but supplies a blank key never silently logs codes.
 *
 * <p>The {@code from} address and {@code subject} are non-secret tunables with safe defaults. The
 * sender domain is {@code 10xai.co.uk} (the human completes SendGrid domain authentication on it via
 * DNS — see the ticket); the default from-address {@code no-reply@10xai.co.uk} matches.
 */
@ConfigurationProperties(prefix = "app.auth.email-code.sendgrid")
public record SendGridProperties(String apiKey, String from, String fromName, String subject) {

    public SendGridProperties {
        if (apiKey == null) {
            apiKey = "";
        }
        if (from == null || from.isBlank()) {
            from = "no-reply@10xai.co.uk";
        }
        if (fromName == null || fromName.isBlank()) {
            fromName = "TeamMarhaba";
        }
        if (subject == null || subject.isBlank()) {
            subject = "Your TeamMarhaba sign-in code";
        }
    }

    /** True when a real SendGrid API key is configured (the signal that activates the real transport). */
    public boolean hasApiKey() {
        return apiKey != null && !apiKey.isBlank();
    }
}
