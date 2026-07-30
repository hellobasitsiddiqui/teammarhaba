package com.teammarhaba.backend.event.recurrence;

/**
 * How often a recurring event repeats (TM-790). v1 thin cut is <b>DAILY</b> and <b>WEEKLY</b> only;
 * monthly (by-date / by-nth-weekday) and other frequencies are deferred to wave-3b and deliberately
 * NOT modelled here — add a value only when the engine grows a branch for it.
 *
 * <p>Intended to persist as its {@code name()} (Hibernate {@code EnumType.STRING}, the same
 * convention as {@link com.teammarhaba.backend.event.EventStatus}) once a JPA entity is introduced,
 * so values may be added but never renamed/removed.
 */
public enum RecurrenceFrequency {

    /** Repeats every {@code interval} day(s). */
    DAILY,

    /** Repeats every {@code interval} week(s) on a single weekday ({@code byWeekday}). */
    WEEKLY
}
