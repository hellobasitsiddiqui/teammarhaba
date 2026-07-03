package com.teammarhaba.backend.event;

/**
 * Lifecycle status of an {@link Event} (TM-391). Stored as VARCHAR via {@code EnumType.STRING}
 * (same convention as {@code users.role}), so values can be added without a DB type change.
 *
 * <p>Distinct from soft-delete: a {@code CANCELLED} event stays readable (so attendees can see it
 * was called off), it is just excluded from the visible-now listing. A soft-deleted event
 * disappears from every normal query.
 */
public enum EventStatus {

    /** Live event: appears in the visible-now listing while inside its visibility window. */
    PUBLISHED,

    /** Called off: kept readable for its attendees/history, hidden from the listing. */
    CANCELLED
}
