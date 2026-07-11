package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The {@link CancelResult} message + ordinal contract (TM-414, extended by the reliability cost/standing
 * in TM-409): a committed late cancel says "this is your Nth" and now names the points it cost, a preview
 * says "this would be your Nth" and the cost, and a free (early / no-op) cancel is silent
 * ({@code message == null}, cost {@code 0}). Pins the English ordinal across the tricky 11–13 exception
 * and the {@code st/nd/rd/th} suffixes so the pre-confirm copy never reads "your 21th" or "your 3th", and
 * pins the reliability-standing sentence appended when the account is warned/downgraded.
 */
class CancelResultTest {

    @Test
    void committedLateCarriesTheRunningCountAndCost() {
        CancelResult result = CancelResult.committedLate(3, 10, ReliabilityStatus.OK);
        assertThat(result.preview()).isFalse();
        assertThat(result.lateCancel()).isTrue();
        assertThat(result.lateCancelCount()).isEqualTo(3);
        assertThat(result.penaltyPoints()).isEqualTo(10);
        assertThat(result.reliabilityStatus()).isEqualTo(ReliabilityStatus.OK);
        assertThat(result.message())
                .isEqualTo("Cancelling now counts as a late cancellation — this is your 3rd. "
                        + "It cost you 10 reliability points.");
    }

    @Test
    void previewLateUsesConditionalWouldWordingAndFutureCost() {
        CancelResult result = CancelResult.previewLate(2, 10, ReliabilityStatus.OK);
        assertThat(result.preview()).isTrue();
        assertThat(result.lateCancel()).isTrue();
        assertThat(result.lateCancelCount()).isEqualTo(2);
        assertThat(result.penaltyPoints()).isEqualTo(10);
        assertThat(result.message())
                .isEqualTo("Cancelling now would count as a late cancellation — this would be your 2nd. "
                        + "It will cost 10 reliability points.");
    }

    @Test
    void warnedAndDowngradedStandingIsAppendedHonestly() {
        assertThat(CancelResult.committedLate(1, 10, ReliabilityStatus.WARNED).message())
                .endsWith("Your account is now on a reliability warning.");
        assertThat(CancelResult.committedLate(3, 10, ReliabilityStatus.DOWNGRADED).message())
                .endsWith("Your account is now limited to the waitlist for capacity-limited events.");
        // The preview frames the standing conditionally ("would be") rather than "is now".
        assertThat(CancelResult.previewLate(3, 10, ReliabilityStatus.DOWNGRADED).message())
                .endsWith("Your account would be limited to the waitlist for capacity-limited events.");
    }

    @Test
    void freeCancelIsSilentAndCostsNothing() {
        CancelResult committed = CancelResult.free(false, 4, ReliabilityStatus.OK);
        assertThat(committed.preview()).isFalse();
        assertThat(committed.lateCancel()).isFalse();
        assertThat(committed.lateCancelCount()).isEqualTo(4);
        assertThat(committed.penaltyPoints()).isZero();
        assertThat(committed.message()).isNull();

        CancelResult preview = CancelResult.free(true, 4, ReliabilityStatus.WARNED);
        assertThat(preview.preview()).isTrue();
        assertThat(preview.reliabilityStatus()).isEqualTo(ReliabilityStatus.WARNED);
        assertThat(preview.message()).isNull();
    }

    @Test
    void ordinalHandlesSuffixesAndTheElevenToThirteenException() {
        assertThat(committedMessage(1)).contains("your 1st.");
        assertThat(committedMessage(2)).contains("your 2nd.");
        assertThat(committedMessage(3)).contains("your 3rd.");
        assertThat(committedMessage(4)).contains("your 4th.");
        assertThat(committedMessage(11)).contains("your 11th.");
        assertThat(committedMessage(12)).contains("your 12th.");
        assertThat(committedMessage(13)).contains("your 13th.");
        assertThat(committedMessage(21)).contains("your 21st.");
        assertThat(committedMessage(22)).contains("your 22nd.");
        assertThat(committedMessage(23)).contains("your 23rd.");
        assertThat(committedMessage(111)).contains("your 111th.");
    }

    private static String committedMessage(int count) {
        return CancelResult.committedLate(count, 10, ReliabilityStatus.OK).message();
    }
}
