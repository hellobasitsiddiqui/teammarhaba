package com.teammarhaba.backend.api;

import com.teammarhaba.backend.alert.Alert;
import com.teammarhaba.backend.alert.AlertDismissal;
import com.teammarhaba.backend.alert.AlertLevel;

/**
 * The <b>public</b> banner shape returned by {@code GET /api/v1/alerts/active} (TM-243). Intentionally
 * minimal — only what the web banner needs to render and dismiss a notice:
 *
 * <ul>
 *   <li>{@code id} — the dismissal key (combined client-side with a content hash for the sticky
 *       "OK" variant so an edited alert re-shows);
 *   <li>{@code message} — the notice text (a public broadcast; never sensitive);
 *   <li>{@code level} — drives the banner colour (mapped to a Paper theme token on the web);
 *   <li>{@code dismissal} — tells the web which dismiss control to render (OK / ✕ / none).
 * </ul>
 *
 * <p>Deliberately <b>omits</b> the actor ({@code createdBy}), the schedule window and internal
 * timestamps: this endpoint is allow-listed for unauthenticated callers (a warning can show pre-login),
 * so it exposes nothing beyond the notice itself. The full record — with attribution and derived
 * status — is only on the admin {@link AlertAdminResponse}.
 *
 * @param id the alert id (the client dismissal key)
 * @param message the notice text
 * @param level the severity (drives colour)
 * @param dismissal how the user may dismiss it
 */
public record AlertResponse(long id, String message, AlertLevel level, AlertDismissal dismissal) {

    public static AlertResponse from(Alert alert) {
        return new AlertResponse(alert.getId(), alert.getMessage(), alert.getLevel(), alert.getDismissal());
    }
}
