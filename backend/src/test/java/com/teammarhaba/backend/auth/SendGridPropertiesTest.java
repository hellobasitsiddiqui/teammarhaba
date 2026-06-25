package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * Verifies the binding + defaults of {@link SendGridProperties} (TM-249): a real key binds with the
 * 10xai.co.uk sender defaults filled in, and a blank/absent key binds cleanly to "no provider"
 * ({@link SendGridProperties#hasApiKey()} false) — so the app-wide {@code @ConfigurationPropertiesScan}
 * can bind it in every environment without crashing dev/test/CI/e2e (fail-loud lives in the bean
 * factory, exercised by {@link EmailCodeMailerConfigTest}).
 */
class SendGridPropertiesTest {

    private final ApplicationContextRunner runner =
            new ApplicationContextRunner().withUserConfiguration(EnableConfig.class);

    @Test
    void bindsKeyAndAppliesSenderDefaults() {
        runner.withPropertyValues("app.auth.email-code.sendgrid.api-key=SG.real-key").run(ctx -> {
            assertThat(ctx).hasNotFailed();
            SendGridProperties props = ctx.getBean(SendGridProperties.class);
            assertThat(props.apiKey()).isEqualTo("SG.real-key");
            assertThat(props.from()).isEqualTo("no-reply@10xai.co.uk");
            assertThat(props.fromName()).isEqualTo("TeamMarhaba");
            assertThat(props.subject()).isEqualTo("Your TeamMarhaba sign-in code");
        });
    }

    @Test
    void overridesSenderDefaultsWhenProvided() {
        runner.withPropertyValues(
                        "app.auth.email-code.sendgrid.api-key=SG.real-key",
                        "app.auth.email-code.sendgrid.from=hello@10xai.co.uk",
                        "app.auth.email-code.sendgrid.from-name=Marhaba",
                        "app.auth.email-code.sendgrid.subject=Code")
                .run(ctx -> {
                    SendGridProperties props = ctx.getBean(SendGridProperties.class);
                    assertThat(props.from()).isEqualTo("hello@10xai.co.uk");
                    assertThat(props.fromName()).isEqualTo("Marhaba");
                    assertThat(props.subject()).isEqualTo("Code");
                });
    }

    @Test
    void bindsBlankKeyAsNoProvider() {
        runner.withPropertyValues("app.auth.email-code.sendgrid.api-key=").run(ctx -> {
            assertThat(ctx).hasNotFailed();
            SendGridProperties props = ctx.getBean(SendGridProperties.class);
            assertThat(props.hasApiKey()).isFalse();
            // Sender defaults still fill in even with no key.
            assertThat(props.from()).isEqualTo("no-reply@10xai.co.uk");
        });
    }

    @Test
    void bindsAbsentKeyAsNoProvider() {
        runner.run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx.getBean(SendGridProperties.class).hasApiKey()).isFalse();
        });
    }

    @Test
    void hasApiKeyTrueForRealKey() {
        runner.withPropertyValues("app.auth.email-code.sendgrid.api-key=SG.real-key")
                .run(ctx -> assertThat(ctx.getBean(SendGridProperties.class).hasApiKey()).isTrue());
    }

    @EnableConfigurationProperties(SendGridProperties.class)
    static class EnableConfig {}
}
