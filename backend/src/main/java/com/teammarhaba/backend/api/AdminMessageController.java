package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.common.PageRequests;
import com.teammarhaba.backend.common.PageResponse;
import com.teammarhaba.backend.messaging.AdminMessageService;
import jakarta.validation.Valid;
import java.util.Set;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin messaging API under {@code /api/v1/admin/messages} (TM-441, epic TM-432) — the backend for the
 * admin compose UI (TM-443). Like {@link PushAdminController} / {@link EventAdminController}, the whole
 * controller is gated by {@code @PreAuthorize("hasRole('ADMIN')")}, so a {@code USER} (or any
 * non-admin) gets a uniform {@code 403} and an anonymous caller is stopped with {@code 401} by the
 * security chain. That gate is also what makes the channel <b>one-way</b>: only an admin can send an
 * admin message; a recipient can never post one (and an admin message is a durable notification, not a
 * conversation, so there is no "reply into it" endpoint at all).
 *
 * <ul>
 *   <li>{@code POST /admin/messages} — send a {@code title}/{@code body} (+ optional deep-link) to a
 *       resolved audience (one of user / city / event ids) and return the campaign + delivery counts.</li>
 *   <li>{@code GET /admin/messages} — the calling admin's sent-message history (TM-442): the campaign
 *       headers they've sent, newest first, paged via the shared list convention. Read-only over the
 *       append-only header table (no new schema).</li>
 *   <li>{@code POST /admin/messages/{id}/recall} — recall (unsend) a message the caller sent (TM-473):
 *       mark the campaign recalled and remove the durable in-app copies (inbox/panel + bell). Scoped to
 *       the caller, so an unknown id or another admin's message is a {@code 404}. Recall only — there is
 *       deliberately no edit endpoint (to change a message, recall it and resend).</li>
 * </ul>
 *
 * <p>Modelled on {@link PushAdminController}: a thin controller that validates the body
 * ({@code @Valid}) and delegates audience resolution, durable delivery, push fan-out and audit to
 * {@link AdminMessageService}. Lives in the {@code api} package so it inherits the {@code /api/v1}
 * prefix ({@link ApiV1Config}). Errors are RFC-7807 ({@code GlobalExceptionHandler}): a malformed body
 * or a spec that doesn't target exactly one type is a {@code 400}, an off-list deep-link is a
 * {@code 400}, and an audience that resolves to nobody is a {@code 400}.
 */
@RestController
@RequestMapping("/admin/messages")
@PreAuthorize("hasRole('ADMIN')")
public class AdminMessageController {

    /**
     * Sort is limited to time/identity — the sent history is a timeline, not an arbitrary query
     * surface (mirrors {@link AuditController}). Anything else is a {@code 400} via {@link PageRequests}.
     */
    private static final Set<String> SORTABLE = Set.of("createdAt", "id");

    /**
     * Newest first — the natural way to read a sent history — with {@code id} as a deterministic
     * same-{@code createdAt} tiebreak, so two campaigns sent in the same instant still page stably.
     */
    private static final Sort DEFAULT_SORT = Sort.by(Sort.Order.desc("createdAt"), Sort.Order.desc("id"));

    private final AdminMessageService adminMessageService;

    public AdminMessageController(AdminMessageService adminMessageService) {
        this.adminMessageService = adminMessageService;
    }

    /**
     * Send an admin message to the resolved audience (TM-441). Bean Validation on the body makes
     * malformed input — including "not exactly one target type" and over-cap title/body/lists — a
     * uniform {@code 400} (per-field {@code errors[]}); an off-list deep-link and an empty resolution
     * are clean {@code 400}s from the service. The caller (from the verified token) is the attributed
     * actor on the campaign header + audit row.
     */
    @PostMapping
    public AdminMessageResponse send(
            @RequestBody @Valid AdminMessageRequest request,
            @AuthenticationPrincipal VerifiedUser caller) {
        return AdminMessageResponse.from(adminMessageService.send(
                caller.uid(),
                request.toAudienceSpec(),
                request.targetType(),
                request.targetRef(),
                request.title(),
                request.body(),
                request.deepLink()));
    }

    /**
     * The calling admin's sent-message history (TM-442): the campaign headers they've sent, newest
     * first, paged. Identity is the verified {@link VerifiedUser} principal, never a client-supplied
     * id, so an admin only ever sees their own sends (the story is "messages <em>I've</em> sent"). Only
     * {@code page}/{@code size}/{@code sort} are tunable; {@code sort} is allow-listed to time/identity
     * ({@link #SORTABLE}) so an unknown property is a clean {@code 400}, and the default is newest-first.
     * Admin-gated by the class {@code @PreAuthorize} (non-admin {@code 403}, anonymous {@code 401}).
     */
    @GetMapping
    public PageResponse<AdminSentHistoryResponse> history(
            @AuthenticationPrincipal VerifiedUser caller,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) String sort) {
        Pageable pageable = PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT);
        return PageResponse.from(
                adminMessageService.sentHistory(caller.uid(), pageable), AdminSentHistoryResponse::from);
    }

    /**
     * Recall (unsend) a message the calling admin previously sent (TM-473): mark the campaign recalled
     * and delete the durable in-app copies it created (they disappear from every recipient's inbox/panel
     * and their notification bell). <b>Recall only</b> — there is no edit endpoint; to change a message,
     * recall it and send a new one. Scoped to the caller by {@link VerifiedUser}, so recalling an unknown
     * id or another admin's message is a uniform {@code 404} (never leaking that it exists). Admin-gated
     * by the class {@code @PreAuthorize} (non-admin {@code 403}, anonymous {@code 401}), and idempotent:
     * recalling an already-recalled message succeeds with {@code removed = 0}.
     *
     * <p><b>Best-effort on push:</b> a push already delivered to a recipient's OS tray can't be un-sent;
     * recall removes the in-app copies only (surfaced in the response/UI copy).
     */
    @PostMapping("/{id}/recall")
    public AdminMessageRecallResponse recall(
            @PathVariable long id, @AuthenticationPrincipal VerifiedUser caller) {
        return AdminMessageRecallResponse.from(adminMessageService.recall(caller.uid(), id));
    }
}
