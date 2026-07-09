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
 * <p><strong>Append-only</strong> is enforced by shape, exactly like {@code AuditEvent} (V4) and
 * {@code NotificationBroadcast} (V10): every field is set once at construction and has no setter, so a
 * loaded row cannot be mutated and flushed. {@link AdminMessageRepository} likewise exposes no
 * update/delete. {@code createdAt} is DB-generated ({@code default now()}) and read back after insert,
 * so the timestamp is authoritative and not caller-supplied.
 *
 * <p>The header records the campaign <em>definition</em> (who/what/target/recipient-count). The
 * per-send <em>delivery</em> outcome (durable rows written, push targeted/delivered/pruned/failed) is
 * recorded on the {@link AuditAction#ADMIN_MESSAGE_SENT} audit row, keeping this header immutable and
 * single-write.
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
}
