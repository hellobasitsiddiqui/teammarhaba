package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.notify.PushRoutes;
import com.teammarhaba.backend.user.UserAdminService;
import com.teammarhaba.backend.web.BadRequestException;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin user-management API under {@code /api/v1/admin/users} (TM-111) — the backend for the admin
 * users console (TM-133). The whole controller is gated by
 * {@code @PreAuthorize("hasRole('ADMIN')")}, so a {@code USER} (or any non-admin) gets a uniform
 * {@code 403}; an anonymous caller is already stopped with {@code 401} by the security chain.
 *
 * <ul>
 *   <li>{@code GET /admin/users} — a page of accounts (paginate + sort; size capped).</li>
 *   <li>{@code GET /admin/users/{id}} — one account (404 if absent — no existence leak).</li>
 *   <li>{@code PATCH /admin/users/{id}} — enable/disable and/or change role (self-protected).</li>
 *   <li>{@code POST /admin/users/{id}/test-push} — manual send-push trigger (TM-284): deliver a test
 *       notification to the account's devices and report the fan-out, to verify push end-to-end.</li>
 *   <li>{@code GET /admin/users/push-routes} — the deep-link route allow-list ({@link PushRoutes#KNOWN},
 *       TM-360): the single source of truth the broadcast/test-push compose picker populates from, so
 *       an admin only ever picks a route the backend will actually accept (rather than a hand-copied
 *       client list that can silently drift).</li>
 * </ul>
 *
 * <p>Lives in the {@code api} package so it inherits the package-driven {@code /api/v1} prefix
 * ({@link ApiV1Config}), consistent with the other API controllers. Pagination here is the
 * <strong>interim</strong> shape ({@link PagedResponse}); TM-115 generalises it into the shared list
 * convention.
 */
@RestController
@RequestMapping("/admin/users")
@PreAuthorize("hasRole('ADMIN')")
public class UserAdminController {

    /** Hard cap on page size so a client can't request an unbounded page (TM-115 will own this). */
    static final int MAX_PAGE_SIZE = 100;

    /** Columns a client is allowed to sort by — guards against sorting by arbitrary/internal fields. */
    static final Set<String> SORTABLE = Set.of("id", "email", "displayName", "role", "enabled");

    private final UserAdminService adminService;

    public UserAdminController(UserAdminService adminService) {
        this.adminService = adminService;
    }

    @GetMapping
    public PagedResponse<UserResponse> list(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(defaultValue = "id,asc") String sort) {
        return PagedResponse.from(adminService.list(toPageable(page, size, sort)), UserResponse::from);
    }

    @GetMapping("/{id}")
    public UserResponse get(@PathVariable long id) {
        return UserResponse.from(adminService.get(id));
    }

    @PatchMapping("/{id}")
    public UserResponse update(
            @PathVariable long id,
            @RequestBody @Valid UpdateUserRequest request,
            @AuthenticationPrincipal VerifiedUser caller) {
        return UserResponse.from(adminService.update(id, request.enabled(), request.role(), caller.uid()));
    }

    /**
     * Manual/test send-push trigger (TM-284): deliver a test notification to the account's devices and
     * return how it fanned out. Lets an admin verify the push path end-to-end against a real device
     * without waiting for an organic event. An optional {@link TestPushRequest} body (TM-290) supplies a
     * deep-link {@code route} so the tap path can be exercised too; an unknown route is a {@code 400}.
     * {@code 404} if the account is absent (no existence leak).
     */
    @PostMapping("/{id}/test-push")
    public PushFanoutResponse testPush(
            @PathVariable long id, @RequestBody(required = false) TestPushRequest request) {
        // TM-290: optional body lets the operator pick a deep-link route; no body = plain test push.
        String route = request == null ? null : request.route();
        return PushFanoutResponse.from(adminService.sendTestPush(id, route));
    }

    /**
     * The deep-link route allow-list (TM-360) — the app hash routes a push/broadcast may deep-link to
     * ({@link PushRoutes#KNOWN}). This is the <strong>single source of truth</strong> the compose
     * picker (test-push here, broadcast in TM-365) populates its dropdown from, so an admin can only
     * ever pick a route the send path will accept ({@link PushRoutes#isKnown}) — no free text, no
     * client-side copy that can drift out of step. Returned sorted for a stable dropdown order and
     * wrapped as {@code {"routes":[...]}} so the shape can grow (e.g. add labels) without a breaking
     * change. Read-only and ADMIN-gated (inherited from the class); a {@code null} 'no deep-link'
     * option is a UI concern, not part of the list.
     */
    @GetMapping("/push-routes")
    public Map<String, List<String>> pushRoutes() {
        return Map.of("routes", List.copyOf(new TreeSet<>(PushRoutes.KNOWN)));
    }

    /** Build a safe {@link Pageable}: clamp page/size and validate the sort field against an allow-list. */
    private static Pageable toPageable(int page, int size, String sort) {
        int safePage = Math.max(page, 0);
        int safeSize = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);

        String[] parts = sort.split(",", 2);
        String field = parts[0].trim();
        if (!SORTABLE.contains(field)) {
            throw new BadRequestException("Invalid sort property '" + field + "'. Allowed: " + SORTABLE);
        }
        Sort.Direction direction = parts.length > 1 && parts[1].trim().equalsIgnoreCase("desc")
                ? Sort.Direction.DESC
                : Sort.Direction.ASC;
        return PageRequest.of(safePage, safeSize, Sort.by(direction, field));
    }
}
