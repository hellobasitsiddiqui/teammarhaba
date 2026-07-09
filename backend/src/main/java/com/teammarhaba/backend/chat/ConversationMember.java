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
 * One person's membership of one {@link Conversation} (TM-435): their thread-scoped {@link
 * MemberRole role}, {@link MuteState mute/removal state}, and read cursor ({@code lastReadAt}).
 *
 * <p>Schema is owned by Flyway ({@code V27__conversation_message_model}); Hibernate runs
 * validate-only, so this mapping must match the table exactly. The DB enforces {@code UNIQUE
 * (conversation_id, user_id)} — one membership per user per thread; a duplicate add surfaces as a
 * {@code DataIntegrityViolationException} for the membership API to map.
 *
 * <p>{@code conversationId}/{@code userId} are plain FK ids, not JPA associations (same convention
 * as {@link com.teammarhaba.backend.event.EventAttendance}), keeping this child decoupled from the
 * parents' aggregates. Accounts are only ever soft-deleted in-app, so membership rows survive an
 * account tombstone; readers resolve people through {@code UserRepository} (which hides tombstoned
 * accounts), never through this table.
 *
 * <p><b>The read cursor</b> — {@code lastReadAt} is how "unread" is computed: messages created after
 * it are unread; {@code null} means the member has never opened the thread (everything is unread).
 * {@link #markRead(Instant)} moves it forward only (a stale re-read never rewinds the cursor).
 * {@code joinedAt} is DB-authoritative ({@code DEFAULT now()}, mapped read-only) — the join order.
 */
@Entity
@Table(name = "conversation_member")
public class ConversationMember {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "conversation_id", nullable = false, updatable = false)
    private Long conversationId;

    @Column(name = "user_id", nullable = false, updatable = false)
    private Long userId;

    @Enumerated(EnumType.STRING)
    @Column(name = "role", nullable = false)
    private MemberRole role;

    @Enumerated(EnumType.STRING)
    @Column(name = "mute", nullable = false)
    private MuteState mute = MuteState.NONE;

    /** The member's read cursor; {@code null} = never read (everything unread). */
    @Column(name = "last_read_at")
    private Instant lastReadAt;

    /** DB-authoritative join instant ({@code DEFAULT now()}) — the membership order; read-only. */
    @Column(name = "joined_at", nullable = false, updatable = false, insertable = false)
    private Instant joinedAt;

    /** Required by JPA. */
    protected ConversationMember() {
    }

    /** A fresh membership; mute starts at {@link MuteState#NONE} (the column default). */
    public ConversationMember(Long conversationId, Long userId, MemberRole role) {
        this.conversationId = conversationId;
        this.userId = userId;
        this.role = role;
        this.mute = MuteState.NONE;
    }

    /**
     * Advance the read cursor to {@code when} — but only forward, so a stale/older read never
     * rewinds it (and a never-read member's {@code null} cursor is always overwritten). Keeps the
     * unread count monotonic.
     */
    public void markRead(Instant when) {
        if (this.lastReadAt == null || when.isAfter(this.lastReadAt)) {
            this.lastReadAt = when;
        }
    }

    /** Change the member's mute/removal state (the moderation lever). */
    public void setMute(MuteState mute) {
        this.mute = mute;
    }

    /** Change the member's thread role. */
    public void setRole(MemberRole role) {
        this.role = role;
    }

    public Long getId() {
        return id;
    }

    public Long getConversationId() {
        return conversationId;
    }

    public Long getUserId() {
        return userId;
    }

    public MemberRole getRole() {
        return role;
    }

    public MuteState getMute() {
        return mute;
    }

    public Instant getLastReadAt() {
        return lastReadAt;
    }

    public Instant getJoinedAt() {
        return joinedAt;
    }

    /** {@code true} while the member is active (not read-only, not removed) — included in fan-out. */
    public boolean isActive() {
        return mute == MuteState.NONE;
    }
}
