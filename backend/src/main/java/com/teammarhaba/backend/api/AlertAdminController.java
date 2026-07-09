package com.teammarhaba.backend.api;

import com.teammarhaba.backend.alert.Alert;
import com.teammarhaba.backend.alert.AlertService;
import com.teammarhaba.backend.auth.VerifiedUser;
import jakarta.validation.Valid;
import java.time.Instant;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin alert-management API under {@code /api/v1/admin/alerts} (TM-243) — the MVP is API-only
 * (callable via curl/console); the compose/preview console UI is an explicit follow-up. Like
 * {@link PushAdminController} / {@link EventAdminController}, the whole controller is gated by
 * {@code @PreAuthorize("hasRole('ADMIN')")}, so a non-admin gets a uniform {@code 403} and an anonymous
 * caller is already stopped with {@code 401} by the security chain (default-deny).
 *
 * <ul>
 *   <li>{@code POST /admin/alerts} — compose + schedule a global alert; {@code 201} with the persisted
 *       row. {@code createdBy} comes from the verified token, never the body.</li>
 *   <li>{@code GET /admin/alerts} — the full history (scheduled/active/expired), newest-first, each row
 *       stamped with its derived status — "what was sent and when".</li>
 *   <li>{@code POST /admin/alerts/{id}/expire} — expire-now: pull a live banner early. Unknown id →
 *       {@code 404}.</li>
 * </ul>
 *
 * <p>Errors are RFC-7807 ({@code GlobalExceptionHandler}). Lives in the {@code api} package so it
 * inherits the package-driven {@code /api/v1} prefix ({@link ApiV1Config}). The whole read is stamped
 * against one server instant ({@link AlertService#now()}) so the derived statuses are internally
 * consistent.
 */
@RestController
@RequestMapping("/admin/alerts")
@PreAuthorize("hasRole('ADMIN')")
public class AlertAdminController {

    private final AlertService alerts;

    AlertAdminController(AlertService alerts) {
        this.alerts = alerts;
    }

    /** Compose + schedule a global alert; {@code createdBy} is the verified admin uid. */
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public AlertAdminResponse create(
            @RequestBody @Valid CreateAlertRequest request, @AuthenticationPrincipal VerifiedUser caller) {
        Alert created = alerts.create(
                caller.uid(),
                request.message(),
                request.level(),
                request.dismissal(),
                request.startsAt(),
                request.expiresAt());
        return AlertAdminResponse.from(created, alerts.now());
    }

    /** The full history, newest-first, each row stamped with its derived status against one server now. */
    @GetMapping
    public List<AlertAdminResponse> history() {
        Instant now = alerts.now();
        return alerts.history().stream()
                .map(alert -> AlertAdminResponse.from(alert, now))
                .toList();
    }

    /** Expire-now — pull a live/scheduled banner early. Unknown id → {@code 404}. */
    @PostMapping("/{id}/expire")
    public AlertAdminResponse expire(@PathVariable long id) {
        return AlertAdminResponse.from(alerts.expireNow(id), alerts.now());
    }
}
