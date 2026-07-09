package com.teammarhaba.backend.chat;

/**
 * The kind of thread a {@link Conversation} is (TM-435). Stored on the {@code conversation} row by
 * {@code name()} via {@code EnumType.STRING} (same convention as {@code users.role} /
 * {@code events.status}), so values may be added but existing names must never be renamed/removed —
 * old rows keep referencing them.
 *
 * <p>The two kinds deliberately share one store so the app's single "chat" section reads both out
 * of the same tables:
 *
 * <ul>
 *   <li>{@code EVENT_GROUP} — a per-event group chat (epic TM-433). Tied to exactly one event via
 *       {@link Conversation#getEventId()}.
 *   <li>{@code ADMIN_BROADCAST} — an admin "from TeamMarhaba" broadcast campaign (epic TM-432). Not
 *       tied to any event ({@code event_id} is null); its messages have a null {@code sender_id}.
 * </ul>
 */
public enum ConversationType {

    /** A per-event group chat; {@code event_id} references the event. */
    EVENT_GROUP,

    /** An admin broadcast campaign; no {@code event_id}, messages are system-sent (null sender). */
    ADMIN_BROADCAST
}
