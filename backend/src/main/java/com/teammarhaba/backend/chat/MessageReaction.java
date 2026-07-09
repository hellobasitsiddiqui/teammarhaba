package com.teammarhaba.backend.chat;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;

/**
 * One member's emoji reaction to one {@link Message} (TM-461) — a lightweight tap that lets a member
 * respond to a message without posting a full reply. A reaction is immutable: it either exists (the
 * member reacted with that emoji) or it doesn't (they un-reacted, and the row is hard-deleted).
 *
 * <p>Schema is owned by Flyway ({@code V28__message_reactions}); Hibernate runs validate-only, so
 * this mapping must match the table exactly. The DB enforces {@code UNIQUE (message_id, user_id,
 * emoji)} — a member can't duplicate the <em>same</em> emoji on a message (a repeat react is an
 * idempotent no-op) but may add several <em>different</em> ones; a concurrent duplicate insert
 * surfaces as a {@link org.springframework.dao.DataIntegrityViolationException} the service treats as
 * "already reacted".
 *
 * <p>{@code messageId}/{@code userId} are plain FK ids, not JPA associations (same convention as
 * {@link Message} and {@link com.teammarhaba.backend.event.EventAttendance}), keeping the reaction
 * decoupled from the parents' aggregates. Accounts are only ever soft-deleted, so the {@code userId}
 * FK never fires; the reacting person is resolved through {@code UserRepository}, never assumed
 * present from this row.
 *
 * <p><b>"Like" is not special.</b> The app's default like is simply a reaction whose {@code emoji}
 * is the default glyph ({@link MessageReactionService#DEFAULT_EMOJI}) — the same row, the same
 * mechanism, no separate table.
 */
@Entity
@Table(name = "message_reaction")
public class MessageReaction {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "message_id", nullable = false, updatable = false)
    private Long messageId;

    /** The reacting member's {@code users.id}. */
    @Column(name = "user_id", nullable = false, updatable = false)
    private Long userId;

    /** The reaction glyph as the client sent it — a unicode emoji or a {@code :shortcode:}. */
    @Column(name = "emoji", nullable = false, updatable = false)
    private String emoji;

    /** DB-authoritative react instant ({@code DEFAULT now()}) — the chip order; read-only. */
    @Column(name = "created_at", nullable = false, updatable = false, insertable = false)
    private Instant createdAt;

    /** Required by JPA. */
    protected MessageReaction() {
    }

    private MessageReaction(Long messageId, Long userId, String emoji) {
        this.messageId = messageId;
        this.userId = userId;
        this.emoji = emoji;
    }

    /** A member's reaction to a message with a given emoji. */
    public static MessageReaction of(Long messageId, Long userId, String emoji) {
        return new MessageReaction(messageId, userId, emoji);
    }

    public Long getId() {
        return id;
    }

    public Long getMessageId() {
        return messageId;
    }

    public Long getUserId() {
        return userId;
    }

    public String getEmoji() {
        return emoji;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
