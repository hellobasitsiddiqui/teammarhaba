package com.teammarhaba.backend.event;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The {@link CancelResult} message + ordinal contract (TM-414): a committed late cancel says "this is
 * your Nth", a preview says "this would be your Nth", and a free (early / no-op) cancel is silent
 * ({@code message == null}). Pins the English ordinal across the tricky 11–13 exception and the
 * {@code st/nd/rd/th} suffixes so the pre-confirm copy never reads "your 21th" or "your 3th".
 */
class CancelResultTest {

    @Test
    void committedLateCarriesTheHonestRunningCountMessage() {
        CancelResult result = CancelResult.committedLate(3);
        assertThat(result.preview()).isFalse();
        assertThat(result.lateCancel()).isTrue();
        assertThat(result.lateCancelCount()).isEqualTo(3);
        assertThat(result.message()).isEqualTo("Cancelling now counts as a late cancellation — this is your 3rd.");
    }

    @Test
    void previewLateUsesConditionalWouldWording() {
        CancelResult result = CancelResult.previewLate(2);
        assertThat(result.preview()).isTrue();
        assertThat(result.lateCancel()).isTrue();
        assertThat(result.lateCancelCount()).isEqualTo(2);
        assertThat(result.message())
                .isEqualTo("Cancelling now would count as a late cancellation — this would be your 2nd.");
    }

    @Test
    void freeCancelIsSilent() {
        CancelResult committed = CancelResult.free(false, 4);
        assertThat(committed.preview()).isFalse();
        assertThat(committed.lateCancel()).isFalse();
        assertThat(committed.lateCancelCount()).isEqualTo(4);
        assertThat(committed.message()).isNull();

        CancelResult preview = CancelResult.free(true, 4);
        assertThat(preview.preview()).isTrue();
        assertThat(preview.message()).isNull();
    }

    @Test
    void ordinalHandlesSuffixesAndTheElevenToThirteenException() {
        assertThat(CancelResult.committedLate(1).message()).contains("your 1st.");
        assertThat(CancelResult.committedLate(2).message()).contains("your 2nd.");
        assertThat(CancelResult.committedLate(3).message()).contains("your 3rd.");
        assertThat(CancelResult.committedLate(4).message()).contains("your 4th.");
        assertThat(CancelResult.committedLate(11).message()).contains("your 11th.");
        assertThat(CancelResult.committedLate(12).message()).contains("your 12th.");
        assertThat(CancelResult.committedLate(13).message()).contains("your 13th.");
        assertThat(CancelResult.committedLate(21).message()).contains("your 21st.");
        assertThat(CancelResult.committedLate(22).message()).contains("your 22nd.");
        assertThat(CancelResult.committedLate(23).message()).contains("your 23rd.");
        assertThat(CancelResult.committedLate(111).message()).contains("your 111th.");
    }
}
