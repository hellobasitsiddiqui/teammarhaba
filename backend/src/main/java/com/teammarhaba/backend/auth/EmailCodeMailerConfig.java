package com.teammarhaba.backend.auth;

import com.teammarhaba.backend.auth.SendGridEmailCodeMailer.DefaultSendGridClient;
import com.teammarhaba.backend.auth.SendGridEmailCodeMailer.SendGridClient;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires login-code delivery (TM-234, TM-249). Two layered beans of the {@link EmailCodeMailer} seam:
 *
 * <ul>
 *   <li>{@link SendGridEmailCodeMailer} — the <strong>real transport</strong>, created only when
 *       {@code app.auth.email-code.sendgrid.api-key} resolves to a <em>non-blank</em> value (the
 *       {@code SENDGRID_API_KEY} secret). Being a concrete {@code @Bean} of {@code EmailCodeMailer},
 *       its mere presence makes the default below back off, so when a key is configured SendGrid
 *       wins.</li>
 *   <li>{@link LoggingEmailCodeMailer} — the dev/test/CI/e2e default, provided only when no other
 *       {@code EmailCodeMailer} bean exists ({@code @ConditionalOnMissingBean}). With no key set,
 *       this is what ships, so local + e2e keep working with no provider.</li>
 * </ul>
 *
 * <p>The emulator's {@code @Primary} recording mailer (TM-134) still wins over both when the
 * Firebase Auth emulator is active — it's how the browser-e2e suite reads the code back.
 *
 * <p><strong>Why a non-blank {@code @ConditionalOnExpression} gate.</strong> The base
 * {@code application.yml} defaults the key to {@code ${SENDGRID_API_KEY:}} so the env var is optional
 * — the property is therefore <em>always present but empty</em> when unset. A plain
 * {@code @ConditionalOnProperty} treats present-but-empty as "set" and would activate SendGrid in
 * <em>every</em> environment. Matching on a non-blank value (the same idiom
 * {@link EmulatorEmailCodeSupport} uses) gives the correct behaviour: no/blank key ⇒ logging stub; a
 * real key ⇒ SendGrid wins. {@link SendGridProperties} itself is bound by the app-wide
 * {@code @ConfigurationPropertiesScan} and tolerates a blank key (so dev/test/CI/e2e bind cleanly);
 * fail-loud lives here — the factory below rejects a blank key defensively, so a half-configured
 * prod that intends SendGrid but supplies a blank key crashes rather than silently logging codes.
 *
 * <p>The conditions are on {@code @Bean}/nested-{@code @Configuration} factories (not
 * component-scanned {@code @Component}s) so they are evaluated after user-defined beans are known —
 * the reliable "default unless overridden" idiom.
 */
@Configuration
public class EmailCodeMailerConfig {

    /** Active only when the SendGrid API key resolves to a non-blank value (see class javadoc). */
    static final String SENDGRID_KEY_SET = "'${app.auth.email-code.sendgrid.api-key:}'.trim() != ''";

    @Bean
    @ConditionalOnMissingBean(EmailCodeMailer.class)
    EmailCodeMailer loggingEmailCodeMailer() {
        return new LoggingEmailCodeMailer();
    }

    /**
     * The real SendGrid transport, contributed only when the API key is a non-blank value. Gated on a
     * nested {@code @Configuration} so the whole block is skipped (no {@code EmailCodeMailer} bean
     * here) when the key is absent/blank, leaving {@link #loggingEmailCodeMailer()} to ship.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnExpression(SENDGRID_KEY_SET)
    static class SendGridMailerConfig {

        @Bean
        EmailCodeMailer sendGridEmailCodeMailer(SendGridProperties props) {
            // Defensive fail-loud: the gate above already guarantees a non-blank key, but never build a
            // real-send bean on a blank key — that would silently fail to deliver every login code.
            if (!props.hasApiKey()) {
                throw new IllegalStateException(
                        "SendGrid login-code transport is active but app.auth.email-code.sendgrid.api-key"
                                + " (SENDGRID_API_KEY) is blank - set a real Mail-Send API key or unset it to"
                                + " fall back to the logging mailer.");
            }
            SendGridClient client = new DefaultSendGridClient(props.apiKey());
            return new SendGridEmailCodeMailer(client, props);
        }
    }
}
