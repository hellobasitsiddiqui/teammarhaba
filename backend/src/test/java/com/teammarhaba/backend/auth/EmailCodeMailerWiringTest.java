package com.teammarhaba.backend.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.mail.javamail.JavaMailSender;

/**
 * Verifies the {@link EmailCodeMailer} bean wiring (TM-249): the default {@link LoggingEmailCodeMailer}
 * ships when mail is unconfigured (so dev/test/CI/e2e keep working), and the real
 * {@link SmtpEmailCodeMailer} takes over — winning over the logging default — when mail is configured
 * via EITHER an explicit {@code app.auth.email-code.smtp.enabled=true} OR a {@code spring.mail.host}.
 *
 * <p>It loads only the two mailer configs (logging imports the SMTP config) plus a stub
 * {@link JavaMailSender}, so no Firebase/DB/SMTP is touched — this is a pure wiring assertion.
 */
class EmailCodeMailerWiringTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(
                    org.springframework.boot.autoconfigure.AutoConfigurations.of(
                            PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(EmailCodeMailerConfig.class, StubMailSenderConfig.class);

    @Test
    void noMailConfig_usesLoggingMailer() {
        runner.run(context -> {
            assertThat(context).hasSingleBean(EmailCodeMailer.class);
            assertThat(context.getBean(EmailCodeMailer.class)).isInstanceOf(LoggingEmailCodeMailer.class);
        });
    }

    @Test
    void explicitEnabledFlag_usesSmtpMailer() {
        runner.withPropertyValues(
                        "app.auth.email-code.smtp.enabled=true",
                        "spring.mail.username=no-reply@10xai.co.uk",
                        "spring.mail.password=app-password")
                .run(context -> {
                    assertThat(context).hasSingleBean(EmailCodeMailer.class);
                    assertThat(context.getBean(EmailCodeMailer.class)).isInstanceOf(SmtpEmailCodeMailer.class);
                });
    }

    @Test
    void mailHostSet_usesSmtpMailer() {
        runner.withPropertyValues(
                        "spring.mail.host=smtp.gmail.com",
                        "spring.mail.username=no-reply@10xai.co.uk",
                        "spring.mail.password=app-password")
                .run(context -> {
                    assertThat(context).hasSingleBean(EmailCodeMailer.class);
                    assertThat(context.getBean(EmailCodeMailer.class)).isInstanceOf(SmtpEmailCodeMailer.class);
                });
    }

    @Test
    void mailEnabledButBlankCreds_failsLoud() {
        runner.withPropertyValues("app.auth.email-code.smtp.enabled=true")
                .run(context -> assertThat(context)
                        .hasFailed()
                        .getFailure()
                        .hasRootCauseInstanceOf(IllegalStateException.class));
    }

    @Configuration
    static class StubMailSenderConfig {
        @Bean
        JavaMailSender javaMailSender() {
            return mock(JavaMailSender.class);
        }
    }
}
