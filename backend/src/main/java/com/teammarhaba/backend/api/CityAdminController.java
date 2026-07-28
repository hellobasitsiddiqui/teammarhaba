package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.city.CityAdminService;
import com.teammarhaba.backend.city.CityCatalogue;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import jakarta.validation.Valid;
import java.util.Map;
import java.util.Set;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
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
 * Admin city-catalogue API under {@code /api/v1/admin/cities} (TM-1089) — the backend for the admin
 * cities console (the console UI itself is a follow-up). The whole controller is gated by
 * {@code @PreAuthorize("hasRole('ADMIN')")}: a non-admin gets a uniform {@code 403}, an anonymous
 * caller a {@code 401} from the security chain, and a missing id is always a plain {@code 404} (no
 * existence leak) — the TM-111 pattern, mirroring {@link InterestAdminController}.
 *
 * <ul>
 *   <li>{@code GET /admin/cities} — paged listing of the FULL catalogue <b>including retired</b> cities,
 *       with optional {@code q} (name/country substring) and {@code active} (tri-state) filters.</li>
 *   <li>{@code GET /admin/cities/{id}} — one city (edit-form load), retired ones included.</li>
 *   <li>{@code POST /admin/cities} — create; {@code 201} with the persisted city.</li>
 *   <li>{@code PATCH /admin/cities/{id}} — partial edit ({@code null} = leave unchanged).</li>
 *   <li>{@code POST /admin/cities/{id}/retire} — soft-delete (keeps the row); idempotent.</li>
 *   <li>{@code POST /admin/cities/{id}/restore} — un-retire; idempotent.</li>
 * </ul>
 *
 * <p>Retire is a POST sub-action, not a DELETE (mirrors interests/venues): the city — and every user/
 * event that saved it by name — survives. Lives in the {@code api} package so it inherits the
 * package-driven {@code /api/v1} prefix ({@link ApiV1Config}).
 */
@RestController
@RequestMapping("/admin/cities")
@PreAuthorize("hasRole('ADMIN')")
public class CityAdminController {

    /** Sortable properties, allow-listed (internals like {@code deletedAt}/{@code version} excluded). */
    static final Set<String> SORTABLE =
            Set.of("id", "name", "country", "sortWeight", "active", "createdAt", "updatedAt");

    /** Default order: weight-first then alphabetically — expressed in DB columns for the native query. */
    private static final Sort DEFAULT_SORT = Sort.by(Sort.Direction.DESC, "sort_weight").and(Sort.by("name"));

    /** Map a public sort property to its {@code city_catalogue} column name for the native admin query. */
    private static final Map<String, String> PROPERTY_TO_COLUMN =
            Map.of("sortWeight", "sort_weight", "createdAt", "created_at", "updatedAt", "updated_at");

    private final CityAdminService adminService;

    public CityAdminController(CityAdminService adminService) {
        this.adminService = adminService;
    }

    @GetMapping
    public PageResponse<AdminCityResponse> list(
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) String sort,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) Boolean active) {
        // Validate the sort against the PUBLIC allow-list (400 on an unknown property), then translate to
        // DB column names for the native admin query.
        Pageable requested = PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT);
        Pageable columnSorted = PageRequest.of(
                requested.getPageNumber(), requested.getPageSize(), toColumnSort(requested.getSort()));
        Page<CityCatalogue> cities = adminService.list(q, active, columnSorted);
        return PageResponse.from(cities, AdminCityResponse::from);
    }

    @GetMapping("/{id}")
    public AdminCityResponse get(@PathVariable long id) {
        return AdminCityResponse.from(adminService.get(id));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public AdminCityResponse create(
            @RequestBody @Valid CreateCityRequest request, @AuthenticationPrincipal VerifiedUser caller) {
        return AdminCityResponse.from(adminService.create(caller, request.toDraft()));
    }

    @PatchMapping("/{id}")
    public AdminCityResponse update(
            @PathVariable long id,
            @RequestBody @Valid UpdateCityRequest request,
            @AuthenticationPrincipal VerifiedUser caller) {
        return AdminCityResponse.from(adminService.update(caller, id, request.toPatch()));
    }

    /**
     * Retire — a POST sub-action rather than DELETE: the city is soft-deleted (tombstoned +
     * {@code active=false}) but the row (and any user/event that saved it by name) survives. Idempotent.
     */
    @PostMapping("/{id}/retire")
    public AdminCityResponse retire(@PathVariable long id, @AuthenticationPrincipal VerifiedUser caller) {
        return AdminCityResponse.from(adminService.retire(caller, id));
    }

    /** Restore — un-retire a tombstoned city. The idempotent mirror of {@link #retire}. */
    @PostMapping("/{id}/restore")
    public AdminCityResponse restore(@PathVariable long id, @AuthenticationPrincipal VerifiedUser caller) {
        return AdminCityResponse.from(adminService.restore(caller, id));
    }

    /** Translate a {@link Sort} of public property names into one of {@code city_catalogue} columns. */
    private static Sort toColumnSort(Sort sort) {
        if (sort.isEmpty()) {
            return sort;
        }
        return Sort.by(sort.stream()
                .map(order ->
                        order.withProperty(PROPERTY_TO_COLUMN.getOrDefault(order.getProperty(), order.getProperty())))
                .toList());
    }
}
