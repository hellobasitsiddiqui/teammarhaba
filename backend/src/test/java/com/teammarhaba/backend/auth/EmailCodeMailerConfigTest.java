package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

/**
 * Verifies the non-blank {@code @ConditionalOnExpression} wiring in {@link EmailCodeMailerConfig}
 * (TM-249):
 *
 * <ul>
 *   <li>with {@code app.auth.email-code.sendgrid.api-key} set to a real value, the real
 *       {@link SendGridEmailCodeMailer} is the active {@link EmailCodeMailer} bean (it wins over the
 *       logging default);</li>
 *   <li>with the key absent, the {@link LoggingEmailCodeMailer} stub ships — so dev/test/CI/e2e keep
 *       working with no provider;</li>
 *   <li>with the key present-but-blank or whitespace-only (the realistic "env var unset/empty" case,
 *       since the base config defaults it to {@code ${SENDGRID_API_KEY:}}), the stub still ships and
 *       the context starts cleanly — the SendGrid bean is <em>not</em> activated by an empty value
 *       (the exact bug that the non-blank expression fixes vs a plain {@code @ConditionalOnProperty}).
 *       </li>
 * </ul>
 *
 * <p>The {@code @NotBlank} on {@link SendGridProperties} is verified directly by
 * {@link SendGridPropertiesTest}; here we assert the wiring never even constructs the bean with a
 * blank key.
 */
class EmailCodeMailerConfigTest {

    // Mirror production: the app-wide @ConfigurationPropertiesScan registers SendGridProperties, so the
    // runner enables it here too (alongside the config under test).
    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withUserConfiguration(TestConfig.class, EmailCodeMailerConfig.class);

    @Configuration
    @EnableConfigurationProperties(SendGridProperties.class)
    static class TestConfig {}

    @Test
    void sendGridMailerActiveWhenApiKeySet() {
        runner.withPropertyValues("app.auth.email-code.sendgrid.api-key=SG.real-key")
                .run(ctx -> {
                    assertThat(ctx).hasNotFailed();
                    assertThat(ctx).hasSingleBean(EmailCodeMailer.class);
                    assertThat(ctx.getBean(EmailCodeMailer.class)).isInstanceOf(SendGridEmailCodeMailer.class);
                });
    }

    @Test
    void loggingMailerActiveWhenApiKeyAbsent() {
        runner.run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx).hasSingleBean(EmailCodeMailer.class);
            assertThat(ctx.getBean(EmailCodeMailer.class)).isInstanceOf(LoggingEmailCodeMailer.class);
        });
    }

    @Test
    void loggingMailerActiveWhenApiKeyBlank() {
        // Present-but-empty (the env-unset default ${SENDGRID_API_KEY:}) must NOT activate SendGrid.
        runner.withPropertyValues("app.auth.email-code.sendgrid.api-key=").run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx).hasSingleBean(EmailCodeMailer.class);
            assertThat(ctx.getBean(EmailCodeMailer.class)).isInstanceOf(LoggingEmailCodeMailer.class);
        });
    }

    @Test
    void loggingMailerActiveWhenApiKeyWhitespaceOnly() {
        runner.withPropertyValues("app.auth.email-code.sendgrid.api-key=   ").run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx.getBean(EmailCodeMailer.class)).isInstanceOf(LoggingEmailCodeMailer.class);
        });
    }
}
