package com.teammarhaba.backend.event;

import com.teammarhaba.backend.config.ReliabilityProperties;
import org.springframework.stereotype.Component;

/**
 * The pure resolver for an account's reliability <em>standing</em> (TM-409) — the threshold engine.
 * Given a running late-cancellation strike count ({@code users.late_cancel_count}, the TM-414
 * counter), it answers "what is this account's standing?" and "is it downgraded?" purely from
 * {@link ReliabilityProperties} config. It is deliberately <b>stateless and side-effect-free</b> so
 * both the read boundaries (the {@code /me} response, the admin console) and the write/enforcement
 * boundary ({@link ReliabilityService}, {@link EventRsvpService}) share one definition of the rules
 * and can never disagree.
 *
 * <p>Mirrors the shape of {@link CancellationPolicy} (TM-414) / {@code LocationRevealPolicy} (TM-408):
 * a small {@code @Component} wrapping a config record. With the feature <b>off</b>
 * ({@code app.reliability.enabled=false}) every account resolves to {@link ReliabilityStatus#OK} and
 * {@link #isDowngraded} is always {@code false}, so the RSVP/claim gate never fires and behaviour is
 * exactly as before TM-409.
 */
@Component
public class ReliabilityPolicy {

    private final ReliabilityProperties properties;

    public ReliabilityPolicy(ReliabilityProperties properties) {
        this.properties = properties;
    }

    /**
     * The account's standing for a given running strike count. {@code DOWNGRADED} once the count
     * reaches {@code downgradeThreshold}, else {@code WARNED} once it reaches {@code warnThreshold},
     * else {@code OK}. Always {@code OK} when the feature is disabled.
     */
    public ReliabilityStatus statusFor(int lateCancelCount) {
        if (!properties.enabled()) {
            return ReliabilityStatus.OK;
        }
        if (lateCancelCount >= properties.downgradeThreshold()) {
            return ReliabilityStatus.DOWNGRADED;
        }
        if (lateCancelCount >= properties.warnThreshold()) {
            return ReliabilityStatus.WARNED;
        }
        return ReliabilityStatus.OK;
    }

    /**
     * Whether an account with this strike count is downgraded — the single predicate the RSVP/claim
     * gate consults. Never downgraded when the feature is off.
     */
    public boolean isDowngraded(int lateCancelCount) {
        return statusFor(lateCancelCount) == ReliabilityStatus.DOWNGRADED;
    }

    /** Reliability points a single late cancellation debits — the "cost" surfaced pre-confirm + in the ledger. */
    public int penaltyPoints() {
        return properties.penaltyPoints();
    }

    /** Whether the reliability standing + downgrade enforcement is switched on. */
    public boolean enabled() {
        return properties.enabled();
    }
}
