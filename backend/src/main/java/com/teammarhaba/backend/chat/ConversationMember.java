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

    /**
     * The member's self-mute of THIS thread's push (TM-471) — orthogonal to {@link #mute}. When
     * {@code true} the new-message fan-out (and any @everyone/@here mention fan-out) skips them, but
     * they remain a full {@link MuteState#NONE active} member: the thread stays visible and they can
     * still read and post. {@code DEFAULT false} (mapped read-safe with a field initialiser so a
     * newly-constructed row is un-muted before its first persist).
     */
    @Column(name = "notifications_muted", nullable = false)
    private boolean notificationsMuted = false;

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

    /**
     * Self-service transitions (TM-471) — the member acting on their OWN membership, distinct from the
     * moderation {@link #setMute} lever above. Kept as named intent methods so the service reads as the
     * domain verbs (mute / unmute / leave / rejoin) rather than raw field pokes.
     */

    /** Self-mute this thread's push (stay an active member; only push is suppressed). */
    public void muteNotifications() {
        this.notificationsMuted = true;
    }

    /** Un-mute this thread's push (return to receiving new-message pushes). */
    public void unmuteNotifications() {
        this.notificationsMuted = false;
    }

    /**
     * Self-leave the thread: hide/exit it ({@link MuteState#LEFT}) while the event RSVP is untouched.
     * Distinct from a moderation {@code REMOVED} so the member can later {@link #rejoin()} and so the
     * RSVP re-sync leaves the leave sticky.
     */
    public void leave() {
        this.mute = MuteState.LEFT;
    }

    /** Self-rejoin a thread the member had left — back to an active {@link MuteState#NONE} member. */
    public void rejoin() {
        this.mute = MuteState.NONE;
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

    /** Whether the member has self-muted this thread's push (TM-471); they stay an active member. */
    public boolean isNotificationsMuted() {
        return notificationsMuted;
    }

    public Instant getLastReadAt() {
        return lastReadAt;
    }

    public Instant getJoinedAt() {
        return joinedAt;
    }

    /** {@code true} while the member is active (not read-only, not left, not removed) — reads + posts. */
    public boolean isActive() {
        return mute == MuteState.NONE;
    }

    /** {@code true} once the member has self-left the thread ({@link MuteState#LEFT}). */
    public boolean hasLeft() {
        return mute == MuteState.LEFT;
    }

    /**
     * Whether push should reach this member for a new message / mention (TM-471): only an
     * {@link #isActive() active} member who has not self-muted push. A {@code READ_ONLY} / {@code LEFT}
     * / {@code REMOVED} member is already push-excluded by {@link #isActive()}; this adds the
     * self-mute filter for an otherwise-active member.
     */
    public boolean receivesPush() {
        return isActive() && !notificationsMuted;
    }
}
