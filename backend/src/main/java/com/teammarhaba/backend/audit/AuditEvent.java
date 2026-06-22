package com.teammarhaba.backend.audit;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.Map;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.generator.EventType;
import org.hibernate.type.SqlTypes;

/**
 * One immutable entry in the append-only audit log (TM-113): "who did what, when".
 *
 * <p>Schema is owned by Flyway ({@code V4__create_audit_events}); Hibernate runs validate-only, so
 * this mapping must match the table exactly.
 *
 * <p><strong>Append-only</strong> is enforced by shape: every field is set once at construction and
 * has no setter, so a loaded row cannot be mutated and flushed. {@link AuditRepository} likewise
 * exposes no update/delete. {@code createdAt} is DB-generated ({@code default now()}) and read back
 * after insert, so the timestamp is authoritative and not caller-supplied.
 */
@Entity
@Table(name = "audit_events")
public class AuditEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** Firebase UID of the actor; {@code null} for system/unattributed actions. */
    @Column(name = "actor_uid", updatable = false)
    private String actorUid;

    @Enumerated(EnumType.STRING)
    @Column(name = "action", nullable = false, updatable = false)
    private AuditAction action;

    @Column(name = "target_type", updatable = false)
    private String targetType;

    @Column(name = "target_id", updatable = false)
    private String targetId;

    /** Optional structured context as JSONB. Never contains secrets/tokens (see AuditService). */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "metadata", updatable = false)
    private Map<String, Object> metadata;

    /** DB-authoritative ({@code default now()}); generated on insert and read back. */
    @org.hibernate.annotations.Generated(event = EventType.INSERT)
    @Column(name = "created_at", nullable = false, insertable = false, updatable = false)
    private Instant createdAt;

    /** Required by JPA. */
    protected AuditEvent() {
    }

    AuditEvent(
            String actorUid,
            AuditAction action,
            String targetType,
            String targetId,
            Map<String, Object> metadata) {
        this.actorUid = actorUid;
        this.action = action;
        this.targetType = targetType;
        this.targetId = targetId;
        this.metadata = metadata;
    }

    public Long getId() {
        return id;
    }

    public String getActorUid() {
        return actorUid;
    }

    public AuditAction getAction() {
        return action;
    }

    public String getTargetType() {
        return targetType;
    }

    public String getTargetId() {
        return targetId;
    }

    public Map<String, Object> getMetadata() {
        return metadata;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
