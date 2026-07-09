package com.teammarhaba.backend.chat;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;

/**
 * One posted message in a {@link Conversation} (TM-435). Immutable once written except for the
 * moderation soft-delete — the chat epics never hard-delete a message.
 *
 * <p>Schema is owned by Flyway ({@code V27__conversation_message_model}); Hibernate runs
 * validate-only, so this mapping must match the table exactly. {@code createdAt} is DB-authoritative
 * ({@code DEFAULT now()}) and read back after insert, so the in-thread order (and the {@code
 * lastReadAt}-relative unread count) can't be caller-skewed.
 *
 * <p>{@code conversationId}/{@code senderId} are plain FK ids, not JPA associations (same convention
 * as {@link com.teammarhaba.backend.event.EventAttendance}). <b>{@code senderId} is nullable:
 * {@code null} = a system / admin "from TeamMarhaba" message</b> (an admin broadcast or an in-thread
 * system notice); a human author is always resolved through {@code UserRepository}, never assumed
 * present here. Accounts are only ever soft-deleted, so the sender FK never fires.
 *
 * <p><b>Moderation soft-delete</b> — {@link #softDelete(Instant)} stamps {@code deletedAt}
 * (one-way, first-moment-wins) so an admin can remove a message without vanishing it: the row is
 * kept as a struck-through "message removed" placeholder, and every timeline/unread read filters
 * {@code deletedAt IS NULL}.
 */
@Entity
@Table(name = "message")
public class Message {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "conversation_id", nullable = false, updatable = false)
    private Long conversationId;

    /** The author's {@code users.id}; {@code null} = a system / admin "from TeamMarhaba" message. */
    @Column(name = "sender_id", updatable = false)
    private Long senderId;

    @Column(name = "body", nullable = false, updatable = false)
    private String body;

    /** Optional in-app route the message opens (e.g. {@code /events/42}); {@code null} if none. */
    @Column(name = "deep_link", updatable = false)
    private String deepLink;

    /** DB-authoritative post instant ({@code DEFAULT now()}) — the in-thread order; read-only. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** Moderation soft-delete; {@code null} = live, non-null = removed by an admin. */
    @Column(name = "deleted_at")
    private Instant deletedAt;

    /** Required by JPA. */
    protected Message() {
    }

    private Message(Long conversationId, Long senderId, String body, String deepLink) {
        this.conversationId = conversationId;
        this.senderId = senderId;
        this.body = body;
        this.deepLink = deepLink;
    }

    /** A message posted by a human member ({@code senderId} is their {@code users.id}). */
    public static Message fromUser(Long conversationId, Long senderId, String body) {
        return new Message(conversationId, senderId, body, null);
    }

    /** As {@link #fromUser} but carrying an in-app deep link. */
    public static Message fromUser(Long conversationId, Long senderId, String body, String deepLink) {
        return new Message(conversationId, senderId, body, deepLink);
    }

    /** A system / admin "from TeamMarhaba" message (null sender) — the admin-broadcast payload. */
    public static Message fromSystem(Long conversationId, String body, String deepLink) {
        return new Message(conversationId, null, body, deepLink);
    }

    /**
     * Moderation soft-delete (idempotent, first-moment-wins): stamps {@code deletedAt} only if the
     * message is still live, so a re-delete never rewrites the original instant. The row is kept —
     * this is never a hard delete.
     */
    public void softDelete(Instant when) {
        if (this.deletedAt == null) {
            this.deletedAt = when;
        }
    }

    public Long getId() {
        return id;
    }

    public Long getConversationId() {
        return conversationId;
    }

    public Long getSenderId() {
        return senderId;
    }

    public String getBody() {
        return body;
    }

    public String getDeepLink() {
        return deepLink;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getDeletedAt() {
        return deletedAt;
    }

    /** {@code true} for a system / admin "from TeamMarhaba" message (no human author). */
    public boolean isSystem() {
        return senderId == null;
    }

    /** {@code true} once the message has been soft-deleted by moderation. */
    public boolean isDeleted() {
        return deletedAt != null;
    }
}
