package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.messaging.AdminMessageService;
import jakarta.validation.Valid;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
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
}
