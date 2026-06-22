package com.teammarhaba.backend.api;

import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import java.util.Set;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin audit read API at {@code /api/v1/audit} (TM-137) — answers "who did what, when" for the
 * admin console's activity view. ADMIN-only ({@code @PreAuthorize("hasRole('ADMIN')")}); a
 * non-admin gets a uniform {@code 403}, anonymous a {@code 401}.
 *
 * <p>Filter by target ({@code targetType} + {@code targetId}) and/or {@code actorUid}; any omitted
 * filter is ignored (no filter at all returns the whole log). Paged via the shared list convention
 * ({@link PageResponse} / {@link PageRequests}), newest first by default. The audit log is
 * append-only, so this is the only way to read it — there is intentionally no write/delete here.
 */
@RestController
@RequestMapping("/audit")
@PreAuthorize("hasRole('ADMIN')")
public class AuditController {

    /** Sort is limited to time/identity — the log is a timeline, not an arbitrary query surface. */
    private static final Set<String> SORTABLE = Set.of("createdAt", "id");

    /** Newest first — the natural way to read an activity log. */
    private static final Sort DEFAULT_SORT = Sort.by(Sort.Direction.DESC, "createdAt");

    private final AuditService audit;

    public AuditController(AuditService audit) {
        this.audit = audit;
    }

    @GetMapping
    public PageResponse<AuditEventResponse> list(
            @RequestParam(required = false) String actorUid,
            @RequestParam(required = false) String targetType,
            @RequestParam(required = false) String targetId,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) String sort) {
        Pageable pageable = PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT);
        return PageResponse.from(audit.search(actorUid, targetType, targetId, pageable), AuditEventResponse::from);
    }
}
