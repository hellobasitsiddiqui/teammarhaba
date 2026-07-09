package com.teammarhaba.backend.api;

import com.teammarhaba.backend.alert.Alert;
import com.teammarhaba.backend.alert.AlertDismissal;
import com.teammarhaba.backend.alert.AlertLevel;
import com.teammarhaba.backend.alert.AlertStatus;
import java.time.Instant;

/**
 * The <b>admin</b> shape for the alert history + mutations ({@code GET/POST /api/v1/admin/alerts},
 * {@code POST /api/v1/admin/alerts/{id}/expire}) — TM-243. Unlike the trimmed public
 * {@link AlertResponse}, this is the full record an operator needs to manage notices: the schedule
 * window, the DB-authoritative {@code createdAt}, the actor ({@code createdBy}) and, crucially, the
 * <b>derived</b> {@link AlertStatus} (scheduled / active / expired) computed against the server clock.
 *
 * <p>{@code status} is not stored — it is stamped at read time from the same server {@code now} the
 * service uses for activeness, so the history's "state" column can never disagree with what the banner
 * actually shows.
 *
 * @param id the alert id
 * @param message the notice text
 * @param level the severity
 * @param dismissal how the user may dismiss it
 * @param scope where it shows (MVP: always {@code global})
 * @param status the derived lifecycle status at the read instant
 * @param startsAt when it becomes visible
 * @param expiresAt when it auto-hides
 * @param createdAt when it was created (server-set)
 * @param createdBy the actor uid that created it
 */
public record AlertAdminResponse(
        long id,
        String message,
        AlertLevel level,
        AlertDismissal dismissal,
        String scope,
        AlertStatus status,
        Instant startsAt,
        Instant expiresAt,
        Instant createdAt,
        String createdBy) {

    /** Map an entity to the admin shape, deriving {@code status} against {@code now} (the server clock). */
    public static AlertAdminResponse from(Alert alert, Instant now) {
        return new AlertAdminResponse(
                alert.getId(),
                alert.getMessage(),
                alert.getLevel(),
                alert.getDismissal(),
                alert.getScope(),
                alert.status(now),
                alert.getStartsAt(),
                alert.getExpiresAt(),
                alert.getCreatedAt(),
                alert.getCreatedBy());
    }
}
