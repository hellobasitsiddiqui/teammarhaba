package com.teammarhaba.backend.event;

/**
 * Lifecycle state of a recurring {@link EventSeries} (TM-789, recurring events v1). Stored as
 * {@code VARCHAR} via {@code EnumType.STRING} (same convention as {@link EventStatus}), so new states
 * can be added without a DB type change.
 *
 * <p>Distinct from soft-delete ({@code deleted_at} + the house {@code @SQLRestriction}): a series can
 * be {@link #ENDED}/{@link #CANCELLED} yet still be a readable, non-tombstoned row.
 */
public enum SeriesStatus {
    /** The series is live and generating occurrences up to its horizon. */
    ACTIVE,
    /** The series reached its natural end ({@code until_date} / {@code occurrence_count}); no more occurrences. */
    ENDED,
    /** The series was called off; future occurrences are stopped. */
    CANCELLED
}
