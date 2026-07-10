package com.teammarhaba.backend.chat;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import org.hibernate.annotations.Generated;
import org.hibernate.generator.EventType;

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
 *
 * <p><b>Reply / quote</b> (TM-466) — {@code replyToMessageId} is an optional self-reference to an
 * earlier message in the <em>same</em> thread this one replies to ({@code null} = a normal, non-reply
 * message). It's set once at post time and never updated; the post path validates the target is a
 * live message in the same conversation before it's stored ({@link MessagePostService}), so a foreign
 * / soft-deleted parent is rejected, never persisted. The read side renders the parent's quoted
 * snippet above the reply, degrading to "message unavailable" if the parent has since been
 * moderation-removed.
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

    /**
     * DB-authoritative post instant ({@code DEFAULT now()}) — the in-thread order; read-only.
     *
     * <p>{@link Generated}{@code (INSERT)} so Hibernate reads the DB-assigned value straight back
     * after the insert (mirrors {@code AdminMessage.createdAt}). Without it the just-persisted
     * entity would carry a {@code null} {@code createdAt} until re-fetched — which the post path
     * (TM-447) needs immediately to return the created-message DTO.
     */
    @Generated(event = EventType.INSERT)
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** Moderation soft-delete; {@code null} = live, non-null = removed by an admin. */
    @Column(name = "deleted_at")
    private Instant deletedAt;

    /**
     * The earlier message in the SAME thread this one replies to (TM-466); {@code null} = a normal,
     * non-reply message. Set once at post time (never updated) after the post path has checked the
     * target is live and same-conversation — so a stored value always points at a real sibling message.
     */
    @Column(name = "reply_to_message_id", updatable = false)
    private Long replyToMessageId;

    /** Required by JPA. */
    protected Message() {
    }

    private Message(Long conversationId, Long senderId, String body, String deepLink, Long replyToMessageId) {
        this.conversationId = conversationId;
        this.senderId = senderId;
        this.body = body;
        this.deepLink = deepLink;
        this.replyToMessageId = replyToMessageId;
    }

    /** A message posted by a human member ({@code senderId} is their {@code users.id}). */
    public static Message fromUser(Long conversationId, Long senderId, String body) {
        return new Message(conversationId, senderId, body, null, null);
    }

    /** As {@link #fromUser} but carrying an in-app deep link. */
    public static Message fromUser(Long conversationId, Long senderId, String body, String deepLink) {
        return new Message(conversationId, senderId, body, deepLink, null);
    }

    /**
     * A reply posted by a human member (TM-466): as {@link #fromUser} but quoting {@code
     * replyToMessageId}, an earlier message in the same thread. The caller (the post path) has already
     * validated the target is a live, same-conversation message.
     */
    public static Message replyFromUser(Long conversationId, Long senderId, String body, Long replyToMessageId) {
        return new Message(conversationId, senderId, body, null, replyToMessageId);
    }

    /** A system / admin "from TeamMarhaba" message (null sender) — the admin-broadcast payload. */
    public static Message fromSystem(Long conversationId, String body, String deepLink) {
        return new Message(conversationId, null, body, deepLink, null);
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

    /** The id of the message this one replies to (TM-466), or {@code null} for a non-reply message. */
    public Long getReplyToMessageId() {
        return replyToMessageId;
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
