package com.teammarhaba.backend.notify;

import com.teammarhaba.backend.audit.AuditAction;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import org.hibernate.generator.EventType;

/**
 * One immutable header row in the append-only admin-broadcast log (TM-359 / epic TM-358): "who sent
 * what title/body to how many recipients, when, with what aggregate outcome". Written once per
 * broadcast by the send endpoint (a later ticket), which also records one {@link
 * AuditAction#BROADCAST_SENT} summary row in the audit log.
 *
 * <p>Schema is owned by Flyway ({@code V10__create_notification_broadcasts}); Hibernate runs
 * validate-only, so this mapping must match the table exactly.
 *
 * <p><strong>Append-only</strong> is enforced by shape, exactly like {@code AuditEvent}: every field
 * is set once at construction and has no setter, so a loaded row cannot be mutated and flushed.
 * {@link NotificationBroadcastRepository} likewise exposes no update/delete. {@code createdAt} is
 * DB-generated ({@code default now()}) and read back after insert, so the timestamp is authoritative
 * and not caller-supplied.
 *
 * <p>The per-recipient child table is deliberately deferred; v1 keeps aggregate counters plus a
 * {@code skipped} count on this header only.
 */
@Entity
@Table(name = "notification_broadcasts")
public class NotificationBroadcast {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Firebase UID of the admin who sent the broadcast; always attributed (never null). */
    @Column(name = "actor_uid", nullable = false, updatable = false)
    private String actorUid;

    @Column(name = "title", nullable = false, updatable = false)
    private String title;

    @Column(name = "body", nullable = false, updatable = false)
    private String body;

    /** Optional in-app deep-link/route the notification opens; {@code null} if none. */
    @Column(name = "route", updatable = false)
    private String route;

    /** How many recipients the broadcast resolved to at send time. */
    @Column(name = "recipient_count", nullable = false, updatable = false)
    private int recipientCount;

    /** Devices/recipients targeting was attempted against. */
    @Column(name = "targeted", nullable = false, updatable = false)
    private int targeted;

    /** Successfully delivered. */
    @Column(name = "delivered", nullable = false, updatable = false)
    private int delivered;

    /** Tokens pruned because FCM reported them unregistered/invalid. */
    @Column(name = "pruned", nullable = false, updatable = false)
    private int pruned;

    /** Delivery attempts that failed (non-prune errors). */
    @Column(name = "failed", nullable = false, updatable = false)
    private int failed;

    /** Recipients skipped (e.g. opted out / no device token). */
    @Column(name = "skipped", nullable = false, updatable = false)
    private int skipped;

    /** DB-authoritative ({@code default now()}); generated on insert and read back. */
    @org.hibernate.annotations.Generated(event = EventType.INSERT)
    @Column(name = "created_at", nullable = false, insertable = false, updatable = false)
    private Instant createdAt;

    /** Required by JPA. */
    protected NotificationBroadcast() {
    }

    public NotificationBroadcast(
            String actorUid,
            String title,
            String body,
            String route,
            int recipientCount,
            int targeted,
            int delivered,
            int pruned,
            int failed,
            int skipped) {
        this.actorUid = actorUid;
        this.title = title;
        this.body = body;
        this.route = route;
        this.recipientCount = recipientCount;
        this.targeted = targeted;
        this.delivered = delivered;
        this.pruned = pruned;
        this.failed = failed;
        this.skipped = skipped;
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

    public String getRoute() {
        return route;
    }

    public int getRecipientCount() {
        return recipientCount;
    }

    public int getTargeted() {
        return targeted;
    }

    public int getDelivered() {
        return delivered;
    }

    public int getPruned() {
        return pruned;
    }

    public int getFailed() {
        return failed;
    }

    public int getSkipped() {
        return skipped;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
