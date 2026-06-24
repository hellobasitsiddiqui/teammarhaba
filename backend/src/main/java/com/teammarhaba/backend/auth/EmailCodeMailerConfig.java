package com.teammarhaba.backend.auth;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

/**
 * Wires the default login-code delivery (TM-234). The {@link LoggingEmailCodeMailer} is provided
 * only when no other {@link EmailCodeMailer} bean exists, so a future mail-provider ticket plugs in
 * a real transport just by registering its own {@code EmailCodeMailer} bean — this default backs off
 * automatically, with no edit here.
 *
 * <p>{@code @ConditionalOnMissingBean} is applied on a {@code @Bean} factory method (not a
 * component-scanned {@code @Component}) so the condition is evaluated after user-defined beans are
 * known — the reliable idiom for a "default unless overridden" bean.
 *
 * <p>{@code @Import(SmtpEmailCodeMailerConfig.class)} (TM-249) registers the real SMTP mailer's
 * config <em>before</em> this default is evaluated, so when mail is configured the SMTP
 * {@link EmailCodeMailer} bean already exists and this {@code @ConditionalOnMissingBean} backs off
 * deterministically — not relying on component-scan ordering between the two configs.
 */
@Configuration
@Import(SmtpEmailCodeMailerConfig.class)
public class EmailCodeMailerConfig {

    @Bean
    @ConditionalOnMissingBean(EmailCodeMailer.class)
    EmailCodeMailer loggingEmailCodeMailer() {
        return new LoggingEmailCodeMailer();
    }
}
