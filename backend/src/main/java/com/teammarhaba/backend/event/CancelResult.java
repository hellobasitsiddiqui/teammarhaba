package com.teammarhaba.backend.event;

/**
 * Outcome of an un-RSVP on the cancellation path (TM-414, extended by the reliability economy TM-409).
 * Tells the caller whether leaving now is a <em>late</em> cancellation (inside the event's cancellation
 * window — default 24h before start), the resulting running strike count, the reliability points it
 * costs, the account's resulting reliability standing, and an honest message to show. Two shapes share
 * the record:
 *
 * <ul>
 *   <li><b>Commit</b> ({@code preview = false}) — the leave was applied; a late cancel has already
 *       bumped {@code lateCancelCount} and debited {@code penaltyPoints} in the ledger. This is what
 *       {@code DELETE /events/{id}/rsvp} returns.</li>
 *   <li><b>Preview</b> ({@code preview = true}) — a non-committing dry-run so the UI can
 *       <em>pre-confirm</em> before the user commits (nothing is written; {@code lateCancelCount} /
 *       {@code reliabilityStatus} are the values it <em>would</em> reach). This is
 *       {@code DELETE …?preview=true} — the transparent "cancelling now costs X points; you're at Y".</li>
 * </ul>
 *
 * <p>{@code message} is populated only when the cancel is (or would be) late — an early cancel is free
 * and silent ({@code message == null}), exactly as the ticket requires. {@code penaltyPoints} is the
 * cost of <em>this</em> cancel: the configured points on a late cancel, {@code 0} on a free one.
 * {@code reliabilityStatus} is the account's standing <em>after</em> the (would-be) strike — the
 * current standing on a free/no-op cancel — so the client can surface a warning/downgrade banner.
 *
 * @param preview           {@code true} for a dry-run that changed nothing; {@code false} once committed
 * @param lateCancel        whether the cancel is (or would be) a late cancellation
 * @param lateCancelCount   the resulting running strike count — post-increment on a committed late
 *                          cancel, the would-be value on a late preview, otherwise the current count
 * @param penaltyPoints     reliability points this cancel costs — the configured penalty when late, {@code 0} otherwise
 * @param reliabilityStatus the account's reliability standing after the (would-be) strike (TM-409)
 * @param message           honest pre-confirm/confirm copy, or {@code null} for a free (early / no-op) cancel
 */
public record CancelResult(
        boolean preview,
        boolean lateCancel,
        int lateCancelCount,
        int penaltyPoints,
        ReliabilityStatus reliabilityStatus,
        String message) {

    /** A committed late cancellation: the strike has landed; {@code newCount} is the post-increment total. */
    public static CancelResult committedLate(int newCount, int penaltyPoints, ReliabilityStatus status) {
        return new CancelResult(
                false,
                true,
                newCount,
                penaltyPoints,
                status,
                "Cancelling now counts as a late cancellation — this is your " + ordinal(newCount)
                        + ". It cost you " + penaltyPoints + " reliability points." + standing(status, true));
    }

    /** A previewed late cancellation: nothing written; {@code wouldBeCount} is the total it would reach. */
    public static CancelResult previewLate(int wouldBeCount, int penaltyPoints, ReliabilityStatus status) {
        return new CancelResult(
                true,
                true,
                wouldBeCount,
                penaltyPoints,
                status,
                "Cancelling now would count as a late cancellation — this would be your " + ordinal(wouldBeCount)
                        + ". It will cost " + penaltyPoints + " reliability points." + standing(status, false));
    }

    /** A free cancel (outside the window, or a no-op leave): no strike, no cost, no message. */
    public static CancelResult free(boolean preview, int currentCount, ReliabilityStatus status) {
        return new CancelResult(preview, false, currentCount, 0, status, null);
    }

    /**
     * The trailing standing sentence appended to a late-cancel message when the account is (or would
     * be) on a warning or downgraded — so the pre-confirm is transparent about the consequence, not
     * just the count. {@code OK} adds nothing.
     */
    private static String standing(ReliabilityStatus status, boolean committed) {
        String verb = committed ? "is now" : "would be";
        return switch (status) {
            case WARNED -> " Your account " + verb + " on a reliability warning.";
            case DOWNGRADED ->
                " Your account " + verb + " limited to the waitlist for capacity-limited events.";
            case OK -> "";
        };
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
