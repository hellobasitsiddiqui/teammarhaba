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
import org.hibernate.annotations.Generated;
import org.hibernate.generator.EventType;

/**
 * One posted message in a {@link Conversation} (TM-435). Immutable once written except for two
 * one-way, first-moment / last-write transitions: the soft-delete ({@code deletedAt}) and — new in
 * TM-467 — the author's own edit ({@code body} rewrite + {@code editedAt} stamp). The chat epics
 * never hard-delete a message.
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
 * <p><b>Soft-delete</b> — {@link #softDelete(Instant)} stamps {@code deletedAt} (one-way,
 * first-moment-wins) so a message can be removed without vanishing it: the row is kept and every
 * timeline/unread read filters {@code deletedAt IS NULL}, so it drops out of the timeline. Two callers
 * share this one lever — admin moderation (TM-449) and, new in TM-467, an author removing their OWN
 * message (author-gated in {@link MessageAuthorService}, allowed anytime) — the entity doesn't
 * distinguish who removed it.
 *
 * <p><b>Author edit</b> (TM-467) — {@link #edit(String, Instant)} rewrites the {@code body} in place
 * and stamps {@code editedAt} (last-write-wins), so an author can fix a typo or reword. It is
 * author-gated and time-boxed (the ~5-minute edit window) by {@link MessageAuthorService}, never here;
 * the entity only exposes the mutation. An edit REPLACES the text — there is no version history (the
 * AC is "fix a typo / take something back", not an audit trail) — and a live edit re-renders over the
 * SSE transport (TM-464) so other members see the new body without a reload. {@code editedAt} is
 * surfaced on {@link com.teammarhaba.backend.api.ConversationMessageResponse} so the client shows an
 * "edited" tag. A soft-deleted message can't be edited (it's already gone from the timeline).
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

    /**
     * The message text. Updatable since TM-467 so an author can {@link #edit(String, Instant)} it in
     * place (a rewrite, not a new row); it was insert-only before self-edit existed.
     */
    @Column(name = "body", nullable = false)
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

    /**
     * Soft-delete instant; {@code null} = live, non-null = removed. Set by admin moderation (TM-449)
     * OR by the author removing their own message (TM-467) — the same one-way lever, indistinguishable
     * here. Every timeline / unread read filters {@code deletedAt IS NULL}, so a removed message drops
     * out of the timeline.
     */
    @Column(name = "deleted_at")
    private Instant deletedAt;

    /**
     * When the author last edited the body (TM-467); {@code null} = never edited. Set by
     * {@link #edit(String, Instant)} (author-gated + within the edit window in
     * {@link MessageAuthorService}); surfaced on the read DTO so the client renders an "edited" tag.
     * Updatable/nullable to match the {@code edited_at} column added by migration V34.
     */
    @Column(name = "edited_at")
    private Instant editedAt;

    /**
     * The earlier message in the SAME thread this one replies to (TM-466); {@code null} = a normal,
     * non-reply message. Set once at post time (never updated) after the post path has checked the
     * target is live and same-conversation — so a stored value always points at a real sibling message.
     */
    @Column(name = "reply_to_message_id", updatable = false)
    private Long replyToMessageId;

    /**
     * What this message <em>is</em> (TM-710): an ordinary {@link MessageKind#ATTENDEE} post, or an
     * admin/host {@link MessageKind#ANNOUNCEMENT} (the auto-posted opening message, or an admin-sent
     * announcement). Set once at post time, never mutated (an author edit rewrites the body but never
     * reclassifies). Defaults to {@code ATTENDEE} so the whole pre-TM-710 back-catalogue reads as one,
     * matching the {@code message.kind} column's {@code DEFAULT 'ATTENDEE'} (V42).
     */
    @Enumerated(EnumType.STRING)
    @Column(name = "kind", nullable = false, updatable = false)
    private MessageKind kind = MessageKind.ATTENDEE;

    /** Required by JPA. */
    protected Message() {
    }

    private Message(
            Long conversationId,
            Long senderId,
            String body,
            String deepLink,
            Long replyToMessageId,
            MessageKind kind) {
        this.conversationId = conversationId;
        this.senderId = senderId;
        this.body = body;
        this.deepLink = deepLink;
        this.replyToMessageId = replyToMessageId;
        this.kind = kind;
    }

    /** A message posted by a human member ({@code senderId} is their {@code users.id}). */
    public static Message fromUser(Long conversationId, Long senderId, String body) {
        return new Message(conversationId, senderId, body, null, null, MessageKind.ATTENDEE);
    }

    /** As {@link #fromUser} but carrying an in-app deep link. */
    public static Message fromUser(Long conversationId, Long senderId, String body, String deepLink) {
        return new Message(conversationId, senderId, body, deepLink, null, MessageKind.ATTENDEE);
    }

    /**
     * A reply posted by a human member (TM-466): as {@link #fromUser} but quoting {@code
     * replyToMessageId}, an earlier message in the same thread. The caller (the post path) has already
     * validated the target is a live, same-conversation message.
     */
    public static Message replyFromUser(Long conversationId, Long senderId, String body, Long replyToMessageId) {
        return new Message(conversationId, senderId, body, null, replyToMessageId, MessageKind.ATTENDEE);
    }

    /**
     * An admin/host {@link MessageKind#ANNOUNCEMENT} (TM-710) posted to an event's group thread: an
     * admin-sent announcement, or the auto-posted opening message. {@code senderId} is the acting
     * admin/host's {@code users.id}, or {@code null} for a system "from TeamMarhaba" announcement (the
     * opening message when no author is attributed). Rendered visually distinct on the client and gated
     * server-side to {@code ROLE_ADMIN} at the post path — a normal attendee post is always
     * {@link MessageKind#ATTENDEE}.
     */
    public static Message announcement(Long conversationId, Long senderId, String body) {
        return new Message(conversationId, senderId, body, null, null, MessageKind.ANNOUNCEMENT);
    }

    /** A system / admin "from TeamMarhaba" message (null sender) — the admin-broadcast payload. */
    public static Message fromSystem(Long conversationId, String body, String deepLink) {
        return new Message(conversationId, null, body, deepLink, null, MessageKind.ATTENDEE);
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

    /**
     * Author edit (TM-467): rewrite the {@code body} in place and stamp {@code editedAt} to {@code
     * when} (last-write-wins — a re-edit re-stamps it). No-op on an already soft-deleted message (a
     * removed message can't be edited). The author gate and the ~5-minute edit window are enforced by
     * {@link MessageAuthorService} before this is called; this method is the pure mutation.
     *
     * @param newBody the replacement text (already validated non-blank + ≤ the length cap at the edge)
     * @param when    the edit instant to stamp {@code editedAt} with
     */
    public void edit(String newBody, Instant when) {
        if (this.deletedAt != null) {
            return; // a removed message is gone from the timeline — nothing to edit
        }
        this.body = newBody;
        this.editedAt = when;
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

    /** When the author last edited this message (TM-467), or {@code null} if it was never edited. */
    public Instant getEditedAt() {
        return editedAt;
    }

    /** The id of the message this one replies to (TM-466), or {@code null} for a non-reply message. */
    public Long getReplyToMessageId() {
        return replyToMessageId;
    }

    /** What this message is (TM-710): an ordinary attendee post or an admin/host announcement. */
    public MessageKind getKind() {
        return kind;
    }

    /** {@code true} when this is an admin/host {@link MessageKind#ANNOUNCEMENT} (TM-710). */
    public boolean isAnnouncement() {
        return kind == MessageKind.ANNOUNCEMENT;
    }

    /** {@code true} for a system / admin "from TeamMarhaba" message (no human author). */
    public boolean isSystem() {
        return senderId == null;
    }

    /** {@code true} once the message has been soft-deleted (by moderation or its author). */
    public boolean isDeleted() {
        return deletedAt != null;
    }

    /** {@code true} once the author has edited this message at least once (TM-467). */
    public boolean isEdited() {
        return editedAt != null;
    }
}
