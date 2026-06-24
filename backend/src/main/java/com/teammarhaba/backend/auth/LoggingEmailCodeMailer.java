package com.teammarhaba.backend.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Default {@link EmailCodeMailer} for environments without a real mail transport yet (TM-234) —
 * the same posture as the email-verification path (TM-165), which logs the trigger and leaves the
 * actual delivery to a future mail-provider ticket.
 *
 * <p>It records that a code <em>was</em> requested for an address (useful for ops/abuse signals)
 * but <strong>never logs the code itself</strong> — the code is a credential. A real transport is
 * introduced later by registering another {@link EmailCodeMailer} bean; this one backs off
 * automatically (see {@link EmailCodeMailerConfig}, which provides it via
 * {@code @ConditionalOnMissingBean}), so wiring a provider is a one-bean change.
 */
public class LoggingEmailCodeMailer implements EmailCodeMailer {

    private static final Logger log = LoggerFactory.getLogger(LoggingEmailCodeMailer.class);

    @Override
    public void sendLoginCode(String email, String code) {
        // The code is intentionally omitted — it is a credential and must never reach the logs.
        log.info("Login code generated and (stub) emailed to {}.", email);
    }
}
