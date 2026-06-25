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

    /**
     * Regression guard for TM-269 — the prod startup crash. When mail is enabled BOTH the SMTP and the
     * logging {@link EmailCodeMailer} beans can register (the logging default's
     * {@code @ConditionalOnMissingBean} backoff is order-dependent and didn't fire in prod), so a
     * consumer that injects a <em>single</em> {@link EmailCodeMailer} — exactly like {@code
     * EmailCodeService} — would fail with "expected single matching bean but found 2" and the app would
     * not start. This test exercises that mail-ON injection path: it loads a single-mailer consumer
     * with mail configured and asserts the context starts AND the consumer is wired with exactly the
     * SMTP mailer (because it is {@code @Primary}). {@code hasSingleBean} alone is not enough — the real
     * bug was an ambiguous <em>injection</em> even when two beans legitimately coexist, which only
     * {@code @Primary} resolves; this asserts the resolution, not just the bean count.
     */
    @Test
    void mailEnabled_singleMailerConsumerGetsSmtpMailer() {
        runner.withUserConfiguration(SingleMailerConsumerConfig.class)
                .withPropertyValues(
                        "spring.mail.host=smtp.gmail.com",
                        "spring.mail.username=no-reply@10xai.co.uk",
                        "spring.mail.password=app-password")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(SingleMailerConsumer.class);
                    assertThat(context.getBean(SingleMailerConsumer.class).mailer())
                            .isInstanceOf(SmtpEmailCodeMailer.class);
                });
    }

    /** Mirror of the above for the mail-OFF path: the single-mailer consumer gets the logging default. */
    @Test
    void noMailConfig_singleMailerConsumerGetsLoggingMailer() {
        runner.withUserConfiguration(SingleMailerConsumerConfig.class).run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(SingleMailerConsumer.class).mailer())
                    .isInstanceOf(LoggingEmailCodeMailer.class);
        });
    }

    /**
     * The exact-reproduction guard for TM-269. The order-dependent {@code @ConditionalOnMissingBean}
     * backoff means BOTH the SMTP and the logging mailer can end up registered at once (that's what
     * happened in prod). This test forces that worst case explicitly — both beans present, the SMTP one
     * carrying its real {@code @Primary} marker via {@link SmtpEmailCodeMailerConfig} — and asserts a
     * single-{@link EmailCodeMailer} consumer still wires unambiguously to the SMTP mailer. Without
     * {@code @Primary} this fails to start with {@code NoUniqueBeanDefinitionException} ("expected single
     * matching bean but found 2"), which is the precise prod crash; with it the resolution is
     * deterministic regardless of definition order.
     */
    @Test
    void bothMailersPresent_singleMailerConsumerResolvesToPrimarySmtp() {
        new ApplicationContextRunner()
                .withConfiguration(org.springframework.boot.autoconfigure.AutoConfigurations.of(
                        PropertyPlaceholderAutoConfiguration.class))
                .withUserConfiguration(
                        StubMailSenderConfig.class,
                        SmtpEmailCodeMailerConfig.class,
                        ForcedLoggingMailerConfig.class,
                        SingleMailerConsumerConfig.class)
                .withPropertyValues(
                        "spring.mail.host=smtp.gmail.com",
                        "spring.mail.username=no-reply@10xai.co.uk",
                        "spring.mail.password=app-password")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    // Sanity: this scenario really does have two EmailCodeMailer beans coexisting.
                    assertThat(context.getBeansOfType(EmailCodeMailer.class)).hasSize(2);
                    assertThat(context.getBean(SingleMailerConsumer.class).mailer())
                            .isInstanceOf(SmtpEmailCodeMailer.class);
                });
    }

    @Configuration
    static class StubMailSenderConfig {
        @Bean
        JavaMailSender javaMailSender() {
            return mock(JavaMailSender.class);
        }
    }

    /**
     * A stand-in for {@code EmailCodeService}: it injects a SINGLE {@link EmailCodeMailer}, so its
     * creation fails if the wiring leaves two candidate beans ambiguous — reproducing the TM-269 crash
     * unless the SMTP mailer is {@code @Primary}.
     */
    @Configuration
    static class SingleMailerConsumerConfig {
        @Bean
        SingleMailerConsumer singleMailerConsumer(EmailCodeMailer mailer) {
            return new SingleMailerConsumer(mailer);
        }
    }

    /**
     * Unconditionally registers the logging mailer (no {@code @ConditionalOnMissingBean}), so the
     * both-mailers-coexist worst case can be forced deterministically in a test — this is what made the
     * prod injection ambiguous, and what {@code @Primary} on the SMTP mailer must resolve.
     */
    @Configuration
    static class ForcedLoggingMailerConfig {
        @Bean
        EmailCodeMailer loggingEmailCodeMailer() {
            return new LoggingEmailCodeMailer();
        }
    }

    record SingleMailerConsumer(EmailCodeMailer mailer) {}
}
