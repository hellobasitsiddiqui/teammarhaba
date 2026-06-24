package com.teammarhaba.backend.auth;

import jakarta.validation.constraints.Min;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Tunables for the passwordless email-code login (TM-234), bound from {@code app.auth.email-code.*}.
 *
 * <p>Every value has a <strong>safe default</strong> so the feature works out of the box in
 * dev/test/CI with no extra config, while prod can tighten any of them via the environment (the
 * usual {@code .env.example} contract). These are tunables, <em>not secrets</em> — the only secret
 * here is the generated code itself, which is never persisted or logged. The numeric bounds are
 * enforced by Bean Validation; the {@link Duration} fields are validated in the compact constructor
 * (Hibernate Validator has no {@code @Positive} validator for {@code Duration}), so a missing or
 * non-positive value fails startup loudly rather than silently degrading the security of the flow.
 *
 * <ul>
 *   <li>{@code length} — number of digits in the one-time code (default 6, matching the SMS UX).</li>
 *   <li>{@code ttl} — how long an issued code stays valid; short by design (default 10 minutes).</li>
 *   <li>{@code sendCooldown} — minimum gap between code requests for the same address; rate-limits
 *       {@code request} + powers a meaningful "Resend" (default 60s, matching the TM-165 cooldown).</li>
 *   <li>{@code maxVerifyAttempts} — wrong guesses allowed against one outstanding code before it is
 *       burned, to stop brute-forcing a short numeric code (default 5).</li>
 * </ul>
 */
@Validated
@ConfigurationProperties(prefix = "app.auth.email-code")
public record EmailCodeProperties(
        @Min(4) int length, Duration ttl, Duration sendCooldown, @Min(1) int maxVerifyAttempts) {

    public EmailCodeProperties {
        if (length == 0) {
            length = 6;
        }
        ttl = requirePositive(ttl, Duration.ofMinutes(10), "app.auth.email-code.ttl");
        sendCooldown = requirePositive(sendCooldown, Duration.ofSeconds(60), "app.auth.email-code.send-cooldown");
        if (maxVerifyAttempts == 0) {
            maxVerifyAttempts = 5;
        }
    }

    /** Apply the default when unset; reject a present-but-non-positive duration (fail loud). */
    private static Duration requirePositive(Duration value, Duration fallback, String key) {
        if (value == null) {
            return fallback;
        }
        if (value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(key + " must be a positive duration, but was " + value);
        }
        return value;
    }
}
