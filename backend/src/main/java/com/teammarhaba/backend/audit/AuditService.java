package com.teammarhaba.backend.audit;

import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The single write seam for the append-only audit log (TM-113). Callers record significant actions
 * through {@link #record}; everything else about the log (immutability, indexing, read patterns)
 * lives behind this service so future entities reuse one consistent path.
 *
 * <p>Runs in the caller's transaction ({@code @Transactional} joins an existing one), so an action
 * and its audit row commit or roll back together — an action is never silently un-audited. The
 * append is a single insert into a simple table, so keeping it in-line adds negligible failure
 * surface ("off the critical path where reasonable").
 */
@Service
public class AuditService {

    private final AuditRepository events;

    public AuditService(AuditRepository events) {
        this.events = events;
    }

    /**
     * Append one immutable audit event.
     *
     * @param actorUid   Firebase UID of the responsible caller, or {@code null} for system actions
     * @param action     what happened
     * @param targetType the kind of thing acted on (e.g. {@code "User"}), or {@code null}
     * @param targetId   identifier of the target, or {@code null}
     * @param metadata   optional structured context — <strong>never</strong> secrets/tokens; may be {@code null}
     */
    @Transactional
    public AuditEvent record(
            String actorUid,
            AuditAction action,
            String targetType,
            String targetId,
            Map<String, Object> metadata) {
        return events.save(new AuditEvent(actorUid, action, targetType, targetId, metadata));
    }

    /** Convenience overload for events that carry no metadata. */
    @Transactional
    public AuditEvent record(String actorUid, AuditAction action, String targetType, String targetId) {
        return record(actorUid, action, targetType, targetId, null);
    }
}
