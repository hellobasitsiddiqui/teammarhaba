package com.teammarhaba.backend.event;

/**
 * Outcome of an un-RSVP on the cancellation path (TM-414). Tells the caller whether leaving now is a
 * <em>late</em> cancellation (inside the event's cancellation window — default 24h before start),
 * the resulting running strike count, and an honest message to show. Two shapes share the record:
 *
 * <ul>
 *   <li><b>Commit</b> ({@code preview = false}) — the leave was applied; a late cancel has already
 *       bumped {@code lateCancelCount}. This is what {@code DELETE /events/{id}/rsvp} returns.</li>
 *   <li><b>Preview</b> ({@code preview = true}) — a non-committing dry-run so the UI can
 *       <em>pre-confirm</em> before the user commits (nothing is written; {@code lateCancelCount} is
 *       the value it <em>would</em> reach). This is {@code DELETE …?preview=true}.</li>
 * </ul>
 *
 * <p>{@code message} is populated only when the cancel is (or would be) late — an early cancel is
 * free and silent ({@code message == null}), exactly as the ticket requires.
 *
 * @param preview         {@code true} for a dry-run that changed nothing; {@code false} once committed
 * @param lateCancel      whether the cancel is (or would be) a late cancellation
 * @param lateCancelCount the resulting running strike count — post-increment on a committed late
 *                        cancel, the would-be value on a late preview, otherwise the current count
 * @param message         honest pre-confirm/confirm copy, or {@code null} for a free (early / no-op) cancel
 */
public record CancelResult(boolean preview, boolean lateCancel, int lateCancelCount, String message) {

    /** A committed late cancellation: the strike has landed; {@code newCount} is the post-increment total. */
    public static CancelResult committedLate(int newCount) {
        return new CancelResult(
                false,
                true,
                newCount,
                "Cancelling now counts as a late cancellation — this is your " + ordinal(newCount) + ".");
    }

    /** A previewed late cancellation: nothing written; {@code wouldBeCount} is the total it would reach. */
    public static CancelResult previewLate(int wouldBeCount) {
        return new CancelResult(
                true,
                true,
                wouldBeCount,
                "Cancelling now would count as a late cancellation — this would be your "
                        + ordinal(wouldBeCount) + ".");
    }

    /** A free cancel (outside the window, or a no-op leave): no strike, no message. */
    public static CancelResult free(boolean preview, int currentCount) {
        return new CancelResult(preview, false, currentCount, null);
    }

    /**
     * English ordinal for the running count in the pre-confirm copy ("your 1st / 2nd / 3rd / 4th …
     * 11th / 12th / 13th … 21st"). The 11–13 exception is why this isn't a plain last-digit switch.
     */
    private static String ordinal(int n) {
        int mod100 = Math.abs(n) % 100;
        String suffix =
                switch (mod100) {
                    case 11, 12, 13 -> "th";
                    default ->
                        switch (mod100 % 10) {
                            case 1 -> "st";
                            case 2 -> "nd";
                            case 3 -> "rd";
                            default -> "th";
                        };
                };
        return n + suffix;
    }
}
