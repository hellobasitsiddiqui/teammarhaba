package com.teammarhaba.backend.messaging;

import com.teammarhaba.backend.audit.AuditAction;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import org.hibernate.generator.EventType;

/**
 * One immutable header row in the append-only admin-message campaign log (TM-441, epic TM-432): "which
 * admin sent what title/body to which resolved audience, how many recipients, when". Written once per
 * send by {@link AdminMessageService}, which also records one {@link AuditAction#ADMIN_MESSAGE_SENT}
 * summary row and one durable {@code ADMIN_MESSAGE} {@code notification} per recipient (cross-linked to
 * this row by {@code source_ref = "admin_message:" + id}).
 *
 * <p>Schema is owned by Flyway ({@code V23__create_admin_messages}); Hibernate runs validate-only, so
 * this mapping must match the table exactly.
 *
 * <p><strong>Append-only campaign definition, with one terminal recall marker.</strong> The campaign
 * <em>definition</em> (actor/title/body/target/recipient-count) is set once at construction and has no
 * setter, exactly like {@code AuditEvent} (V4) and {@code NotificationBroadcast} (V10) — a loaded row's
 * definition cannot be mutated and flushed. {@code createdAt} is DB-generated ({@code default now()})
 * and read back after insert, so the timestamp is authoritative and not caller-supplied.
 *
 * <p>The <b>one</b> allowed mutation is <b>recall</b> (TM-473): an admin can later pull a sent message
 * back, which stamps a separate, one-way {@code recalledAt}/{@code recalledBy} marker via
 * {@link #markRecalled(String, java.time.Instant)} (set-if-null, like {@code Notification.markSeen}).
 * That does not rewrite any part of the definition — it only records "this campaign was later recalled,
 * by whom, when", which the sent-history view (TM-442) surfaces as {@code RECALLED}. So the definition
 * stays immutable and single-write; {@link AdminMessageRepository} still exposes no delete and its only
 * insert is {@link AdminMessageRepository#save}.
 *
 * <p>The per-send <em>delivery</em> outcome (durable rows written, push targeted/delivered/pruned/failed)
 * is recorded on the {@link AuditAction#ADMIN_MESSAGE_SENT} audit row; the recall outcome (rows removed)
 * on an {@link AuditAction#ADMIN_MESSAGE_RECALLED} row.
 */
@Entity
@Table(name = "admin_message")
public class AdminMessage {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Firebase UID of the admin who sent the message; always attributed (never null). */
    @Column(name = "actor_uid", nullable = false, updatable = false)
    private String actorUid;

    @Column(name = "title", nullable = false, updatable = false)
    private String title;

    @Column(name = "body", nullable = false, updatable = false)
    private String body;

    /** Optional in-app deep-link/route the message opens; {@code null} if none. */
    @Column(name = "deep_link", updatable = false)
    private String deepLink;

    /** Which single audience dimension this send targeted (USER | CITY | EVENT). */
    @Enumerated(EnumType.STRING)
    @Column(name = "target_type", nullable = false, updatable = false)
    private TargetType targetType;

    /** Human-readable descriptor of the target (id CSV / city name(s)) for the sent-history view. */
    @Column(name = "target_ref", nullable = false, updatable = false)
    private String targetRef;

    /** How many recipients the audience resolved to at send time (the A1 snapshot). */
    @Column(name = "recipient_count", nullable = false, updatable = false)
    private int recipientCount;

    /** DB-authoritative ({@code default now()}); generated on insert and read back. */
    @org.hibernate.annotations.Generated(event = EventType.INSERT)
    @Column(name = "created_at", nullable = false, insertable = false, updatable = false)
    private Instant createdAt;

    /**
     * When this campaign was recalled (TM-473); {@code null} = still live. The one mutable field on the
     * header — set once by {@link #markRecalled(String, Instant)} and never rewritten. Nullable so every
     * pre-recall row is valid unchanged (V25 adds the column with no default).
     */
    @Column(name = "recalled_at")
    private Instant recalledAt;

    /** Firebase UID of the admin who recalled it (TM-473); {@code null} until recalled. */
    @Column(name = "recalled_by")
    private String recalledBy;

    /** Required by JPA. */
    protected AdminMessage() {
    }

    public AdminMessage(
            String actorUid,
            String title,
            String body,
            String deepLink,
            TargetType targetType,
            String targetRef,
            int recipientCount) {
        this.actorUid = actorUid;
        this.title = title;
        this.body = body;
        this.deepLink = deepLink;
        this.targetType = targetType;
        this.targetRef = targetRef;
        this.recipientCount = recipientCount;
    }

    public Long getId() {
        return id;
    }

    public String getActorUid() {
        return actorUid;
    }

    public String getTitle() {
        return title;
    }

    public String getBody() {
        return body;
    }

    public String getDeepLink() {
        return deepLink;
    }

    public TargetType getTargetType() {
        return targetType;
    }

    public String getTargetRef() {
        return targetRef;
    }

    public int getRecipientCount() {
        return recipientCount;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    /**
     * Mark this campaign recalled (TM-473): the admin pulled the sent message back. One-way and
     * idempotent — the first call stamps {@code recalledAt}/{@code recalledBy}; a later call is a no-op
     * so the original recall moment + actor are preserved (mirrors {@code Notification.markSeen}). The
     * caller ({@code AdminMessageService.recall}) does the actual removal of the in-app copies and the
     * audit; this only records the terminal state on the header. Does not touch the immutable definition.
     *
     * @param uid  Firebase UID of the admin recalling the message (attribution; never null)
     * @param when the recall timestamp
     * @return {@code true} if this call performed the recall (was live), {@code false} if already recalled
     */
    public boolean markRecalled(String uid, Instant when) {
        if (this.recalledAt != null) {
            return false;
        }
        this.recalledAt = when;
        this.recalledBy = uid;
        return true;
    }

    /** Whether this campaign has been recalled (drives the {@code RECALLED} sent-history status). */
    public boolean isRecalled() {
        return recalledAt != null;
    }

    /** When the campaign was recalled, or {@code null} if it is still live. */
    public Instant getRecalledAt() {
        return recalledAt;
    }

    /** Firebase UID of the admin who recalled it, or {@code null} if it is still live. */
    public String getRecalledBy() {
        return recalledBy;
    }
}
