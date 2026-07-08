package com.teammarhaba.backend.notify;

/**
 * The kind of thing a persisted {@link Notification} tells a user about (TM-452). Stored on the
 * {@code notification} row by {@code name()} via {@code EnumType.STRING} (same convention as {@code
 * users.role} / {@code device_tokens.platform}), so values may be added but existing names must not
 * be renamed/removed — old rows keep referencing them.
 *
 * <ul>
 *   <li>{@code ADMIN_MESSAGE} — a message an admin sent to the user (the admin-send path, TM-441 /
 *       TM-453); the only type that may be {@linkplain Notification#isSticky() sticky}.
 *   <li>{@code EVENT_UPDATED} — an event the user is attending changed (time/place/details).
 *   <li>{@code EVENT_CANCELLED} — an event the user is attending was cancelled.
 *   <li>{@code WAITLIST_OFFER} — a spot opened up and the user is being offered it off the waitlist.
 *   <li>{@code RSVP_CONFIRMED} — the user's RSVP/join was confirmed.
 *   <li>{@code EVENT_REMINDER} — a scheduled reminder that an event the user is attending is soon.
 * </ul>
 */
public enum NotificationType {
    ADMIN_MESSAGE,
    EVENT_UPDATED,
    EVENT_CANCELLED,
    WAITLIST_OFFER,
    RSVP_CONFIRMED,
    EVENT_REMINDER
}
