package com.teammarhaba.backend.audit;

import java.util.Map;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The seam for the append-only audit log (TM-113). Callers record significant actions through
 * {@link #record}; everything else about the log (immutability, indexing, read patterns) lives
 * behind this service so future entities reuse one consistent path. The admin read endpoint
 * (TM-137) reads through {@link #search}.
 *
 * <p>Writes run in the caller's transaction ({@code @Transactional} joins an existing one), so an
 * action and its audit row commit or roll back together — an action is never silently un-audited.
 * The append is a single insert into a simple table, so keeping it in-line adds negligible failure
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

    /**
     * Paged audit read for the admin endpoint (TM-137). All filters optional ({@code null}/blank
     * disables a clause); ordering comes from {@code pageable} (default newest-first).
     */
    @Transactional(readOnly = true)
    public Page<AuditEvent> search(String actorUid, String targetType, String targetId, Pageable pageable) {
        return events.search(blankToNull(actorUid), blankToNull(targetType), blankToNull(targetId), pageable);
    }

    private static String blankToNull(String value) {
        return (value == null || value.isBlank()) ? null : value;
    }
}
