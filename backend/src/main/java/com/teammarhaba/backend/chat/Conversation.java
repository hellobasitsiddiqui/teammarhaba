package com.teammarhaba.backend.chat;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;

/**
 * One conversation thread (TM-435) — the shared root both admin broadcasts (TM-432) and event group
 * chat (TM-433) persist into, so the app's single "chat" section reads every thread out of one
 * store. A thread is either an {@link ConversationType#EVENT_GROUP} (tied to one event) or an
 * {@link ConversationType#ADMIN_BROADCAST} (no event, system-sent messages).
 *
 * <p>Schema is owned by Flyway ({@code V27__conversation_message_model}); Hibernate runs
 * validate-only, so this mapping must match the table exactly. {@code createdAt} is DB-authoritative
 * ({@code DEFAULT now()}) and read back after insert, so the thread-list order can't be caller-skewed.
 *
 * <p>{@code eventId} is a plain FK id (to {@code events.id}), not a JPA association — same convention
 * as {@link com.teammarhaba.backend.event.EventAttendance} — keeping the thread decoupled from the
 * {@code Event} aggregate's soft-delete {@code @SQLRestriction}. It is {@code null} for an
 * {@code ADMIN_BROADCAST}; for an {@code EVENT_GROUP} a partial-unique index guarantees at most one
 * thread per event, which is why the repositories look it up as an {@code Optional}.
 *
 * <p><b>Mutable state is only {@code closedAt}.</b> What the thread <em>is</em> (type/event) is set
 * once at construction; the only transition is {@link #close(Instant)} — a one-way, idempotent
 * set-if-null soft-close that keeps history readable rather than hard-deleting.
 */
@Entity
@Table(name = "conversation")
public class Conversation {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Enumerated(EnumType.STRING)
    @Column(name = "type", nullable = false, updatable = false)
    private ConversationType type;

    /** The event this group thread belongs to; {@code null} for an admin broadcast. */
    @Column(name = "event_id", updatable = false)
    private Long eventId;

    /** DB-authoritative creation instant ({@code DEFAULT now()}); read-only on the entity. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** When the thread was soft-closed; {@code null} = open. */
    @Column(name = "closed_at")
    private Instant closedAt;

    /** Required by JPA. */
    protected Conversation() {
    }

    private Conversation(ConversationType type, Long eventId) {
        this.type = type;
        this.eventId = eventId;
    }

    /**
     * A new group thread for one event. The event's single group chat — the partial-unique index on
     * {@code event_id} rejects a second one (surfaced as a {@code DataIntegrityViolationException}).
     */
    public static Conversation forEvent(Long eventId) {
        return new Conversation(ConversationType.EVENT_GROUP, eventId);
    }

    /** A new admin broadcast thread — no event, its messages are system-sent (null sender). */
    public static Conversation adminBroadcast() {
        return new Conversation(ConversationType.ADMIN_BROADCAST, null);
    }

    /**
     * Soft-close the thread (idempotent, first-moment-wins): stamps {@code closedAt} only if it is
     * still open, so a re-close never rewrites the original instant. History stays readable — this
     * is never a hard delete.
     */
    public void close(Instant when) {
        if (this.closedAt == null) {
            this.closedAt = when;
        }
    }

    public Long getId() {
        return id;
    }

    public ConversationType getType() {
        return type;
    }

    public Long getEventId() {
        return eventId;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getClosedAt() {
        return closedAt;
    }

    /** {@code true} once the thread has been soft-closed. */
    public boolean isClosed() {
        return closedAt != null;
    }
}
