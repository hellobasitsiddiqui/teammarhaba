package com.teammarhaba.backend.api;

import com.teammarhaba.backend.alert.AlertService;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The public read path for the site-wide alert banner (TM-243), under {@code /api/v1/alerts} (the
 * {@code /api/v1} prefix is applied by {@link ApiV1Config}).
 *
 * <ul>
 *   <li>{@code GET /alerts/active} — the currently-<b>active</b> global alerts, newest-first. This is
 *       the banner's read: the web polls it (~5 min) and renders each returned notice.</li>
 * </ul>
 *
 * <p><b>Unauthenticated by design.</b> This route is allow-listed in {@code SecurityConfig} so a
 * warning can show <em>pre-login</em> (e.g. a heatwave notice on the landing/login screen). Because it
 * is public, the {@link AlertResponse} shape carries only the notice itself (id/message/level/
 * dismissal) — never the actor, schedule or internal timestamps — and the {@code message} content must
 * never be sensitive: it is a public broadcast.
 *
 * <p>"Active" is decided <b>server-side</b> against the service clock ({@code startsAt <= now <
 * expiresAt}); a scheduled or expired alert is never returned, so a client can't talk one into showing.
 */
@RestController
public class AlertController {

    private final AlertService alerts;

    AlertController(AlertService alerts) {
        this.alerts = alerts;
    }

    /** The active global alerts, newest-first — the banner's public read. */
    @GetMapping("/alerts/active")
    public List<AlertResponse> active() {
        return alerts.activeGlobal().stream().map(AlertResponse::from).toList();
    }
}
