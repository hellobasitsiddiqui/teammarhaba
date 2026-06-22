package com.teammarhaba.backend.api;

import com.teammarhaba.backend.audit.AuditEvent;
import java.time.Instant;
import java.util.Map;

/**
 * API view of an {@link AuditEvent} for the admin audit read endpoint (TM-137). The {@code action}
 * is the enum name; {@code createdAt} is the DB-authoritative timestamp. Metadata never carries
 * secrets (enforced at the write seam).
 *
 * @param id         the event id
 * @param actorUid   Firebase UID of the responsible caller (may be {@code null} for system actions)
 * @param action     the {@link com.teammarhaba.backend.audit.AuditAction} name
 * @param targetType the kind of thing acted on (e.g. {@code "User"})
 * @param targetId   identifier of the target
 * @param metadata   optional structured context (never secrets)
 * @param createdAt  when it happened (DB-authoritative)
 */
public record AuditEventResponse(
        Long id,
        String actorUid,
        String action,
        String targetType,
        String targetId,
        Map<String, Object> metadata,
        Instant createdAt) {

    public static AuditEventResponse from(AuditEvent event) {
        return new AuditEventResponse(
                event.getId(),
                event.getActorUid(),
                event.getAction().name(),
                event.getTargetType(),
                event.getTargetId(),
                event.getMetadata(),
                event.getCreatedAt());
    }
}
