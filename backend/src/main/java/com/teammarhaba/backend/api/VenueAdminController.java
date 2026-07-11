package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.event.Venue;
import com.teammarhaba.backend.event.VenueAdminService;
import jakarta.validation.Valid;
import java.util.Set;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin venue-management API under {@code /api/v1/admin/venues} (TM-519, events epic) — the backend
 * for the admin venues console and the event-create venue picker. The whole controller is gated by
 * {@code @PreAuthorize("hasRole('ADMIN')")}: a non-admin gets a uniform {@code 403}, an anonymous
 * caller a {@code 401} from the security chain, and a missing id is always a plain {@code 404} (no
 * existence leak) — the TM-111 pattern, mirroring {@link EventAdminController}.
 *
 * <ul>
 *   <li>{@code GET /admin/venues} — paged listing of the venue inventory, with an optional
 *       case-insensitive {@code q} search over name/city and an {@code active} filter (the
 *       event-create picker passes {@code active=true}; the console omits it to see the full
 *       inventory including deactivated venues).</li>
 *   <li>{@code GET /admin/venues/{id}} — one venue (edit-form load).</li>
 *   <li>{@code POST /admin/venues} — create; {@code 201} with the persisted venue.</li>
 *   <li>{@code PATCH /admin/venues/{id}} — partial edit ({@code null} = leave unchanged); the edit
 *       reflects on every event referencing this venue.</li>
 *   <li>{@code POST /admin/venues/{id}/deactivate} — retire it from the picker; the record (and any
 *       referencing events) survives. Idempotent.</li>
 *   <li>{@code POST /admin/venues/{id}/reactivate} — offer it again. Idempotent.</li>
 * </ul>
 *
 * <p>Every mutation is audited (TM-113). Venue photos ride the house avatar pattern (TM-166): the
 * console uploads {@code venue-images/{venueId}} straight to Firebase Storage (admin-only per
 * {@code storage.rules}) and persists only the path via PATCH. Errors are RFC-7807
 * ({@code GlobalExceptionHandler}); lists use the shared TM-115 conventions
 * ({@link PageRequests}/{@link PageResponse}). Lives in the {@code api} package so it inherits the
 * package-driven {@code /api/v1} prefix ({@link ApiV1Config}).
 */
@RestController
@RequestMapping("/admin/venues")
@PreAuthorize("hasRole('ADMIN')")
public class VenueAdminController {

    /** Sortable columns, allow-listed per TM-115 so internals (e.g. {@code deletedAt}) never leak. */
    static final Set<String> SORTABLE = Set.of("id", "name", "city", "active", "createdAt", "updatedAt");

    /** Default order: newest first — a freshly added venue surfaces at the top of the console. */
    private static final Sort DEFAULT_SORT = Sort.by(Sort.Direction.DESC, "createdAt");

    private final VenueAdminService adminService;

    public VenueAdminController(VenueAdminService adminService) {
        this.adminService = adminService;
    }

    @GetMapping
    public PageResponse<VenueResponse> list(
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) String sort,
            @RequestParam(required = false) String q,
            @RequestParam(required = false, defaultValue = "false") boolean active) {
        Page<Venue> venues = adminService.list(q, active, PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT));
        return PageResponse.from(venues, VenueResponse::from);
    }

    @GetMapping("/{id}")
    public VenueResponse get(@PathVariable long id) {
        return VenueResponse.from(adminService.get(id));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public VenueResponse create(
            @RequestBody @Valid CreateVenueRequest request, @AuthenticationPrincipal VerifiedUser caller) {
        return VenueResponse.from(adminService.create(caller, request.toDraft()));
    }

    @PatchMapping("/{id}")
    public VenueResponse update(
            @PathVariable long id,
            @RequestBody @Valid UpdateVenueRequest request,
            @AuthenticationPrincipal VerifiedUser caller) {
        return VenueResponse.from(adminService.update(caller, id, request.toPatch()));
    }

    /**
     * Deactivate — deliberately a POST sub-action rather than a DELETE: the venue is retired from the
     * event-create picker but the record (and any referencing events) survives, visible in this
     * console with {@code active = false}.
     */
    @PostMapping("/{id}/deactivate")
    public VenueResponse deactivate(@PathVariable long id, @AuthenticationPrincipal VerifiedUser caller) {
        return VenueResponse.from(adminService.deactivate(caller, id));
    }

    /** Reactivate — offer the venue in the picker again. The mirror of {@link #deactivate}. */
    @PostMapping("/{id}/reactivate")
    public VenueResponse reactivate(@PathVariable long id, @AuthenticationPrincipal VerifiedUser caller) {
        return VenueResponse.from(adminService.reactivate(caller, id));
    }
}
