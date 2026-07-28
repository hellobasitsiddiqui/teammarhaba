package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.notify.BroadcastService;
import jakarta.validation.Valid;
import java.util.Set;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin push API under {@code /api/v1/admin/push} (TM-363, epic TM-358) — the backend for the admin
 * broadcast/compose feature. Like {@link UserAdminController}, the whole controller is gated by
 * {@code @PreAuthorize("hasRole('ADMIN')")}, so a {@code USER} (or any non-admin) gets a uniform
 * {@code 403} and an anonymous caller is already stopped with {@code 401} by the security chain.
 *
 * <ul>
 *   <li>{@code POST /admin/push/broadcast} — send a custom title/body (+ optional deep-link route) to a
 *       chosen set of accounts and return the aggregate + per-recipient fan-out.</li>
 *   <li>{@code GET /admin/push/broadcasts} — the calling admin's push-broadcast sent-history (TM-373):
 *       the broadcast headers they've sent, newest first, paged via the shared list convention.
 *       Read-only over the append-only header table (no new schema). Recall / AI recipient search are
 *       out of scope for this MVP — it is a read-only list.</li>
 * </ul>
 *
 * <p>Modelled on {@link UserAdminController#testPush}: a thin controller that validates the body
 * ({@code @Valid}) and delegates the fan-out, persistence and audit to {@link BroadcastService}. Lives
 * in the {@code api} package so it inherits the {@code /api/v1} prefix ({@link ApiV1Config}).
 *
 * <p>This is intentionally the base broadcast. The opt-out/skip-disabled safety rails (TM-364) and the
 * compose UI (TM-365) build on top of this endpoint without changing it.
 */
@RestController
@RequestMapping("/admin/push")
@PreAuthorize("hasRole('ADMIN')")
public class PushAdminController {

    /**
     * Sort is limited to time/identity — the sent history is a timeline, not an arbitrary query
     * surface (mirrors {@link AdminMessageController}). Anything else is a {@code 400} via
     * {@link PageRequests}.
     */
    private static final Set<String> SORTABLE = Set.of("createdAt", "id");

    /**
     * Newest first — the natural way to read a sent history — with {@code id} as a deterministic
     * same-{@code createdAt} tiebreak, so two broadcasts sent in the same instant still page stably.
     */
    private static final Sort DEFAULT_SORT = Sort.by(Sort.Order.desc("createdAt"), Sort.Order.desc("id"));

    private final BroadcastService broadcastService;

    public PushAdminController(BroadcastService broadcastService) {
        this.broadcastService = broadcastService;
    }

    /**
     * Broadcast a custom notification to the requested accounts (TM-363). Bean Validation on the body
     * makes malformed input a uniform {@code 400} (per-field {@code errors[]}); an off-list {@code route}
     * is a clean {@code 400} from the service. A missing user id or a user with no devices is reported in
     * the per-recipient result, not thrown — so a well-formed request returns {@code 200} with the
     * aggregate + per-recipient outcomes. The caller (from the verified token) is the attributed actor on
     * the broadcast + audit rows.
     */
    @PostMapping("/broadcast")
    public BroadcastPushResponse broadcast(
            @RequestBody @Valid BroadcastPushRequest request,
            @AuthenticationPrincipal VerifiedUser caller) {
        return BroadcastPushResponse.from(broadcastService.broadcast(
                caller.uid(), request.userIds(), request.title(), request.body(), request.route()));
    }

    /**
     * The calling admin's push-broadcast sent-history (TM-373): the broadcast headers they've sent,
     * newest first, paged. Identity is the verified {@link VerifiedUser} principal, never a
     * client-supplied id, so an admin only ever sees their own sends (the story is "broadcasts
     * <em>I've</em> sent"). Only {@code page}/{@code size}/{@code sort} are tunable; {@code sort} is
     * allow-listed to time/identity ({@link #SORTABLE}) so an unknown property is a clean {@code 400},
     * and the default is newest-first. Admin-gated by the class {@code @PreAuthorize} (non-admin
     * {@code 403}, anonymous {@code 401}); read-only over the append-only header table.
     */
    @GetMapping("/broadcasts")
    public PageResponse<BroadcastHistoryResponse> history(
            @AuthenticationPrincipal VerifiedUser caller,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) String sort) {
        Pageable pageable = PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT);
        return PageResponse.from(
                broadcastService.history(caller.uid(), pageable), BroadcastHistoryResponse::from);
    }
}
