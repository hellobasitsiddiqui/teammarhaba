package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import com.teammarhaba.backend.config.ReliabilityProperties;
import org.junit.jupiter.api.Test;

/**
 * The reliability threshold engine (TM-409) — {@link ReliabilityPolicy} deriving an account's standing
 * from its running late-cancellation strike count against the configured warn/downgrade thresholds.
 * Pure resolver, no Spring: asserts the OK → WARNED → DOWNGRADED boundaries, the master-switch
 * short-circuit, and the config accessors.
 */
class ReliabilityPolicyTest {

    /** penalty 10, warn @2, downgrade @4 — thresholds spaced so each band is exercised distinctly. */
    private final ReliabilityPolicy policy =
            new ReliabilityPolicy(new ReliabilityProperties(true, 10, 2, 4));

    @Test
    void belowWarnThresholdIsOk() {
        assertThat(policy.statusFor(0)).isEqualTo(ReliabilityStatus.OK);
        assertThat(policy.statusFor(1)).isEqualTo(ReliabilityStatus.OK); // one below warn
        assertThat(policy.isDowngraded(1)).isFalse();
    }

    @Test
    void atWarnThresholdIsWarnedButNotDowngraded() {
        assertThat(policy.statusFor(2)).isEqualTo(ReliabilityStatus.WARNED); // exactly at warn
        assertThat(policy.statusFor(3)).isEqualTo(ReliabilityStatus.WARNED); // between warn and downgrade
        assertThat(policy.isDowngraded(3)).isFalse();
    }

    @Test
    void atOrAboveDowngradeThresholdIsDowngraded() {
        assertThat(policy.statusFor(4)).isEqualTo(ReliabilityStatus.DOWNGRADED); // exactly at downgrade
        assertThat(policy.statusFor(9)).isEqualTo(ReliabilityStatus.DOWNGRADED); // well past
        assertThat(policy.isDowngraded(4)).isTrue();
    }

    @Test
    void disabledFeatureIsAlwaysOkAndNeverDowngraded() {
        ReliabilityPolicy off = new ReliabilityPolicy(new ReliabilityProperties(false, 10, 1, 2));
        assertThat(off.statusFor(100)).isEqualTo(ReliabilityStatus.OK);
        assertThat(off.isDowngraded(100)).isFalse();
        assertThat(off.enabled()).isFalse();
    }

    @Test
    void exposesConfiguredPenaltyPoints() {
        assertThat(policy.penaltyPoints()).isEqualTo(10);
        assertThat(policy.enabled()).isTrue();
    }

    @Test
    void defaultsApplyOnNullConfig() {
        ReliabilityPolicy defaults =
                new ReliabilityPolicy(new ReliabilityProperties(null, null, null, null));
        assertThat(defaults.penaltyPoints()).isEqualTo(ReliabilityProperties.DEFAULT_PENALTY_POINTS);
        assertThat(defaults.statusFor(0)).isEqualTo(ReliabilityStatus.OK);
        assertThat(defaults.statusFor(ReliabilityProperties.DEFAULT_WARN_THRESHOLD))
                .isEqualTo(ReliabilityStatus.WARNED);
        assertThat(defaults.isDowngraded(ReliabilityProperties.DEFAULT_DOWNGRADE_THRESHOLD)).isTrue();
    }

    @Test
    void downgradeThresholdBelowWarnIsRaisedToWarn() {
        // Misconfiguration guard: downgrade can never trigger before the warning. warn=5, downgrade=2
        // is normalised so downgrade >= warn, i.e. both effectively 5.
        ReliabilityPolicy misconfigured =
                new ReliabilityPolicy(new ReliabilityProperties(true, 10, 5, 2));
        assertThat(misconfigured.statusFor(4)).isEqualTo(ReliabilityStatus.OK); // below the (raised) threshold
        assertThat(misconfigured.statusFor(5)).isEqualTo(ReliabilityStatus.DOWNGRADED);
    }
}
