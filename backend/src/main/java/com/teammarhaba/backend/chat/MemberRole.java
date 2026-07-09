package com.teammarhaba.backend.chat;

/**
 * A member's role within one {@link Conversation} (TM-435) — thread-scoped, distinct from the
 * account-wide {@code auth.Role}. Stored on the {@code conversation_member} row via
 * {@code EnumType.STRING} (same convention as {@code users.role}), so values may be added but
 * existing names must never be renamed/removed.
 *
 * <ul>
 *   <li>{@code MEMBER} — an ordinary participant: reads and (unless muted {@code READ_ONLY}) posts.
 *   <li>{@code ADMIN} — may moderate the thread (soft-delete messages, manage members). The event
 *       organiser / the broadcaster is an {@code ADMIN} member of their thread.
 * </ul>
 */
public enum MemberRole {

    /** An ordinary participant of the thread. */
    MEMBER,

    /** A member who may moderate the thread (organiser / broadcaster). */
    ADMIN
}
