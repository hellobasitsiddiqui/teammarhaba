package com.teammarhaba.backend.auth;

import jakarta.validation.constraints.Min;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
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
 *   <li>{@code maxOutstanding} — hard cap on how many addresses can have in-memory auth state at once
 *       (the {@code pending} + {@code lastSent} stores). Bounds memory so a flood of distinct random
 *       addresses can't grow the heap without limit; entries also expire on their own (TM-247,
 *       default 100000 — generous for a single instance, ~tens of MB worst case).</li>
 *   <li>{@code ipRequestLimit} — max {@code request} calls allowed from one client IP per
 *       {@code ipRequestWindow} before the endpoint returns {@code 429}; a coarse per-IP limit in
 *       front of the per-address cooldown, so varied addresses from one source are still throttled
 *       (TM-247, default 20).</li>
 *   <li>{@code ipRequestWindow} — the fixed window for {@code ipRequestLimit} (TM-247, default 1m).</li>
 *   <li>{@code maxTrackedIps} — hard cap on how many client IPs the per-IP limiter tracks at once, so
 *       the limiter itself can't become a new unbounded map under a spoofed-{@code X-Forwarded-For}
 *       flood (TM-247, default 100000). Counters also expire after {@code ipRequestWindow}.</li>
 *   <li>{@code test} — the inbox-free test-email hook (TM-312); see {@link TestEmail}. Default
 *       <strong>empty</strong> (disabled) so prod is a no-op and real users are unaffected.</li>
 * </ul>
 */
@Validated
@ConfigurationProperties(prefix = "app.auth.email-code")
public record EmailCodeProperties(
        @Min(4) int length,
        Duration ttl,
        Duration sendCooldown,
        @Min(1) int maxVerifyAttempts,
        @Min(1) long maxOutstanding,
        @Min(1) int ipRequestLimit,
        Duration ipRequestWindow,
        @Min(1) long maxTrackedIps,
        TestEmail test) {

    public EmailCodeProperties {
        if (length == 0) {
            length = 6;
        }
        ttl = requirePositive(ttl, Duration.ofMinutes(10), "app.auth.email-code.ttl");
        sendCooldown = requirePositive(sendCooldown, Duration.ofSeconds(60), "app.auth.email-code.send-cooldown");
        if (maxVerifyAttempts == 0) {
            maxVerifyAttempts = 5;
        }
        if (maxOutstanding == 0) {
            maxOutstanding = 100_000;
        }
        if (ipRequestLimit == 0) {
            ipRequestLimit = 20;
        }
        ipRequestWindow =
                requirePositive(ipRequestWindow, Duration.ofMinutes(1), "app.auth.email-code.ip-request-window");
        if (maxTrackedIps == 0) {
            maxTrackedIps = 100_000;
        }
        if (test == null) {
            test = TestEmail.disabled();
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

    /**
     * The inbox-free test-email hook (TM-312) — the email twin of the SMS test phone number (TM-309).
     * For an <strong>allow-listed</strong> address {@link EmailCodeService} issues a <em>fixed, known</em>
     * code and <em>skips</em> the real email send, so the email-code login can be driven end-to-end in
     * CI without reading an inbox. Real addresses are completely unaffected: random code, real send, full
     * cooldown / attempt caps.
     *
     * <p><strong>Guarded for prod.</strong> The hook is active only when the allow-list is non-empty
     * (an address matches an allow-listed domain or an explicit allow-listed address). The default is an
     * <em>empty</em> allow-list, i.e. {@link #isEnabled()} is {@code false}, so the feature is a no-op in
     * prod — exactly the spirit of TM-309's gate. Bind from {@code app.auth.email-code.test.*}:
     *
     * <ul>
     *   <li>{@code allowedDomains} — domain suffixes (e.g. {@code @teammarhaba.test}) whose addresses
     *       take the test path. Matched case-insensitively; a leading {@code @} is optional.</li>
     *   <li>{@code allowedAddresses} — explicit full addresses (e.g. {@code e2e@teammarhaba.test}) that
     *       take the test path. Matched case-insensitively after trim.</li>
     *   <li>{@code fixedCode} — the known code returned for allow-listed addresses (e.g. {@code 123456}).
     *       Defaults to {@code 123456} but is inert unless the allow-list is non-empty.</li>
     * </ul>
     *
     * <p>Flagging these accounts as {@code accountType=test} is follow-up <strong>TM-311</strong>, not in
     * scope here — this ticket only adds the inbox-free login path.
     */
    public record TestEmail(List<String> allowedDomains, List<String> allowedAddresses, String fixedCode) {

        private static final String DEFAULT_FIXED_CODE = "123456";

        public TestEmail {
            // Empty (not null) lists so callers never have to null-check; normalise to lowercase so the
            // membership check is a plain, case-insensitive contains/endsWith against a normalised email.
            allowedDomains = normaliseDomains(allowedDomains);
            allowedAddresses = normaliseAddresses(allowedAddresses);
            if (fixedCode == null || fixedCode.isBlank()) {
                fixedCode = DEFAULT_FIXED_CODE;
            } else {
                fixedCode = fixedCode.trim();
            }
        }

        /** The default: empty allow-list => disabled, so prod is a no-op and real users are unaffected. */
        static TestEmail disabled() {
            return new TestEmail(List.of(), List.of(), DEFAULT_FIXED_CODE);
        }

        /** The hook is OFF unless something is allow-listed — the prod safety gate (cf. TM-309). */
        public boolean isEnabled() {
            return !allowedDomains.isEmpty() || !allowedAddresses.isEmpty();
        }

        /**
         * Is {@code normalisedEmail} (already trimmed + lowercased by {@code EmailCodeService.normalise})
         * on the test allow-list? False whenever the hook is disabled, so a real address is never matched.
         */
        public boolean matches(String normalisedEmail) {
            if (!isEnabled() || normalisedEmail == null || normalisedEmail.isBlank()) {
                return false;
            }
            if (allowedAddresses.contains(normalisedEmail)) {
                return true;
            }
            for (String domain : allowedDomains) {
                if (normalisedEmail.endsWith(domain)) {
                    return true;
                }
            }
            return false;
        }

        private static List<String> normaliseDomains(List<String> raw) {
            if (raw == null) {
                return List.of();
            }
            return raw.stream()
                    .filter(d -> d != null && !d.isBlank())
                    .map(d -> d.trim().toLowerCase(Locale.ROOT))
                    // Store as the "@example.test" suffix so a plain endsWith() can't match a substring of
                    // another domain (e.g. "evil-teammarhaba.test" must NOT match "teammarhaba.test").
                    .map(d -> d.startsWith("@") ? d : "@" + d)
                    .toList();
        }

        private static List<String> normaliseAddresses(List<String> raw) {
            if (raw == null) {
                return List.of();
            }
            return raw.stream()
                    .filter(a -> a != null && !a.isBlank())
                    .map(a -> a.trim().toLowerCase(Locale.ROOT))
                    .toList();
        }
    }
}
