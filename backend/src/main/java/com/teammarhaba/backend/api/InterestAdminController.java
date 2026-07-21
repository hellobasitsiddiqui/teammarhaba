package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.interests.InterestAdminService;
import com.teammarhaba.backend.interests.InterestCatalogue;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.Set;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin interest-catalogue API under {@code /api/v1/admin/interests} (TM-774, epic Interests) — the
 * backend for the admin interests console (the console UI itself is TM-779/I7). The whole controller
 * is gated by {@code @PreAuthorize("hasRole('ADMIN')")}: a non-admin gets a uniform {@code 403}, an
 * anonymous caller a {@code 401} from the security chain, and a missing id is always a plain
 * {@code 404} (no existence leak) — the TM-111 pattern, mirroring {@link VenueAdminController}. There
 * is deliberately NO age-gate here (neither existing admin controller has one; the RBAC guard is the
 * only gate).
 *
 * <ul>
 *   <li>{@code GET /admin/interests} — paged listing of the FULL catalogue <b>including retired</b>
 *       interests (the user-facing list already filters to active), with optional {@code q} (label
 *       substring), {@code category} (exact), and {@code active} (tri-state) filters.</li>
 *   <li>{@code GET /admin/interests/{id}} — one interest (edit-form load), retired ones included.</li>
 *   <li>{@code POST /admin/interests} — create; {@code 201} with the persisted interest.</li>
 *   <li>{@code PATCH /admin/interests/{id}} — partial edit ({@code null} = leave unchanged).</li>
 *   <li>{@code POST /admin/interests/{id}/retire} — soft-delete (keeps the row); idempotent.</li>
 *   <li>{@code POST /admin/interests/{id}/restore} — un-retire; idempotent.</li>
 *   <li>{@code GET}/{@code PUT /admin/interests/config} — read/set the min/max-selection bounds.</li>
 * </ul>
 *
 * <p>Retire is a POST sub-action, not a DELETE (mirrors venues' deactivate/reactivate): the interest —
 * and every user snapshot that copied it — survives. Config is a fixed singleton sub-resource under
 * {@code /config}; it can't collide with the numeric {@code {id}} paths because {@code {id}} is typed
 * {@code long} (Spring won't bind the literal "config" to a {@code long} path variable, so the literal
 * {@code /config} mapping wins). Lives in the {@code api} package so it inherits the package-driven
 * {@code /api/v1} prefix ({@link ApiV1Config}).
 */
@RestController
@RequestMapping("/admin/interests")
@PreAuthorize("hasRole('ADMIN')")
public class InterestAdminController {

    /**
     * Sortable properties, allow-listed per TM-115 (internals like {@code deletedAt}/{@code version}
     * excluded). These are the PUBLIC JPA property names (consistent with events/venues); the native
     * admin query needs DB column names, so {@link #toColumnSort} maps them before the repo call.
     */
    static final Set<String> SORTABLE =
            Set.of("id", "label", "category", "sortWeight", "highlighted", "active", "createdAt", "updatedAt");

    /**
     * Default order: highlights/popular first (higher {@code sort_weight} first), then alphabetically —
     * the same order the user-facing picker uses, expressed in DB columns for the native admin query.
     */
    private static final Sort DEFAULT_SORT = Sort.by(Sort.Direction.DESC, "sort_weight").and(Sort.by("label"));

    /**
     * Map a public sort property to its {@code interest_catalogue} column name for the native admin
     * query (Spring Data appends a native query's sort verbatim as SQL, so camelCase would be an unknown
     * column). Only the two camelCase properties differ; the rest are identical.
     */
    private static final Map<String, String> PROPERTY_TO_COLUMN =
            Map.of("sortWeight", "sort_weight", "createdAt", "created_at", "updatedAt", "updated_at");

    private final InterestAdminService adminService;

    public InterestAdminController(InterestAdminService adminService) {
        this.adminService = adminService;
    }

    @GetMapping
    public PageResponse<AdminInterestResponse> list(
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) String sort,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String category,
            @RequestParam(required = false) Boolean active) {
        // Validate the sort against the PUBLIC allow-list (400 on an unknown property), then translate to
        // DB column names for the native admin query.
        Pageable requested = PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT);
        Pageable columnSorted =
                org.springframework.data.domain.PageRequest.of(
                        requested.getPageNumber(), requested.getPageSize(), toColumnSort(requested.getSort()));
        Page<InterestCatalogue> interests = adminService.list(q, category, active, columnSorted);
        return PageResponse.from(interests, AdminInterestResponse::from);
    }

    @GetMapping("/{id}")
    public AdminInterestResponse get(@PathVariable long id) {
        return AdminInterestResponse.from(adminService.get(id));
    }

    /**
     * Per-interest selection analytics for the console's "Selected by" column (TM-832): each selected
     * label's selector count + its percentage of the active user base, plus the {@code activeUsers}
     * denominator. Count + percent only — the gender split is deferred (TM-955). ADMIN-gated like the rest
     * of the controller (non-admin → 403). A fixed literal sub-resource under {@code /stats}; it can't
     * collide with the numeric {@code {id}} path (typed {@code long}), exactly like {@code /config}.
     */
    @GetMapping("/stats")
    public InterestSelectionStatsResponse stats() {
        InterestAdminService.SelectionStats result = adminService.selectionStats();
        return new InterestSelectionStatsResponse(
                result.activeUsers(),
                result.stats().stream()
                        .map(s -> new InterestSelectionStatsResponse.UserInterestStat(
                                s.label(), s.selectorCount(), s.percent()))
                        .toList());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public AdminInterestResponse create(
            @RequestBody @Valid CreateInterestRequest request, @AuthenticationPrincipal VerifiedUser caller) {
        return AdminInterestResponse.from(adminService.create(caller, request.toDraft()));
    }

    @PatchMapping("/{id}")
    public AdminInterestResponse update(
            @PathVariable long id,
            @RequestBody @Valid UpdateInterestRequest request,
            @AuthenticationPrincipal VerifiedUser caller) {
        return AdminInterestResponse.from(adminService.update(caller, id, request.toPatch()));
    }

    /**
     * Retire — a POST sub-action rather than DELETE: the interest is soft-deleted (tombstoned +
     * {@code active=false}) but the row (and any user snapshot that copied it) survives. Idempotent.
     */
    @PostMapping("/{id}/retire")
    public AdminInterestResponse retire(@PathVariable long id, @AuthenticationPrincipal VerifiedUser caller) {
        return AdminInterestResponse.from(adminService.retire(caller, id));
    }

    /** Restore — un-retire a tombstoned interest. The idempotent mirror of {@link #retire}. */
    @PostMapping("/{id}/restore")
    public AdminInterestResponse restore(@PathVariable long id, @AuthenticationPrincipal VerifiedUser caller) {
        return AdminInterestResponse.from(adminService.restore(caller, id));
    }

    /** Read the interests min/max-selection bounds. */
    @GetMapping("/config")
    public InterestConfigResponse getConfig() {
        return InterestConfigResponse.from(adminService.getConfig());
    }

    /** Set both interests min/max-selection bounds (full replacement; {@code min <= max} enforced). */
    @PutMapping("/config")
    public InterestConfigResponse setConfig(
            @RequestBody @Valid InterestConfigRequest request, @AuthenticationPrincipal VerifiedUser caller) {
        return InterestConfigResponse.from(
                adminService.setConfig(caller, request.minSelections(), request.maxSelections()));
    }

    /** Translate a {@link Sort} of public property names into one of {@code interest_catalogue} columns. */
    private static Sort toColumnSort(Sort sort) {
        if (sort.isEmpty()) {
            return sort;
        }
        return Sort.by(sort.stream()
                .map(order -> order.withProperty(PROPERTY_TO_COLUMN.getOrDefault(order.getProperty(), order.getProperty())))
                .toList());
    }
}
