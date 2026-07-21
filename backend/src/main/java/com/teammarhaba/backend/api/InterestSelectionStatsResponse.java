package com.teammarhaba.backend.api;

import java.util.List;

/**
 * Per-interest selection analytics for the admin interests console (TM-832) — the "Selected by" column.
 * For each interest LABEL that anyone has selected, how many users picked it ({@code selectorCount}) and
 * what share of the ACTIVE user base that is ({@code percent}, a whole-number 0–100).
 *
 * <p><b>Scope (decided):</b> selector COUNT + PERCENT only. The male/female split is deliberately out of
 * scope — it needs a user gender field that does not exist yet — and is tracked separately as TM-955. Do
 * not read a gender dimension into this shape.
 *
 * <p><b>Keyed by label, not id.</b> A {@link UserInterestStat#label} is the free-text snapshot label
 * (TM-773), which is how the front end joins these stats onto its catalogue rows (a catalogue row and its
 * selections share the label the user picked it as). A selection of a since-renamed or since-retired
 * interest is still tallied under the label it was picked as — so a retired interest keeps its historical
 * count — and a label nobody has selected is simply absent from {@link #stats} (the client renders a
 * missing label as {@code 0 (0%)}).
 *
 * <p>{@link #activeUsers} is the percentage denominator (enabled, non-deleted accounts) surfaced so the
 * client can show/verify the basis; it is 0-guarded server-side so {@code percent} is always 0 when there
 * are no active users (never a divide-by-zero).
 *
 * @param activeUsers the percentage denominator: count of active (enabled, non-deleted) accounts
 * @param stats       one entry per selected label — {@code selectorCount} + {@code percent}
 */
public record InterestSelectionStatsResponse(long activeUsers, List<UserInterestStat> stats) {

    /**
     * One interest label's selection tally.
     *
     * @param label         the interest label the count is keyed on (the free-text snapshot label)
     * @param selectorCount how many {@code user_interest} rows carry this label ({@code COUNT(*)})
     * @param percent       {@code selectorCount} as a whole-number share of active users (0–100), 0-guarded
     */
    public record UserInterestStat(String label, long selectorCount, int percent) {}
}
