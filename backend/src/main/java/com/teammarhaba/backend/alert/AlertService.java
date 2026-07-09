package com.teammarhaba.backend.alert;

import com.teammarhaba.backend.web.ResourceNotFoundException;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The site-wide alert domain (TM-243): compose/schedule a global banner, list the history, expire one
 * early, and read the currently-active set for the banner. It is the single owner of the "is this
 * alert active <em>right now</em>" decision — every time question resolves against the injected
 * {@link Clock}, never the client, which is what lets the AC promise "server decides active".
 *
 * <p>Follows the house Clock seam ({@code BroadcastService} / {@code EventReminderService}): the
 * Spring-wired constructor uses {@link Clock#systemUTC()}; a package-visible constructor takes a
 * fixed/advanceable clock so a unit test can pin "now" to a boundary.
 */
@Service
public class AlertService {

    private final AlertRepository alerts;
    private final Clock clock;

    @Autowired
    public AlertService(AlertRepository alerts) {
        this(alerts, Clock.systemUTC());
    }

    /** Test seam: inject a fixed/advanceable {@link Clock} (house pattern). */
    AlertService(AlertRepository alerts, Clock clock) {
        this.alerts = alerts;
        this.clock = clock;
    }

    /** The server's current instant — the single authoritative "now" for activeness + derived status. */
    public Instant now() {
        return clock.instant();
    }

    /**
     * The currently-active global alerts, newest-first — the banner's read path. Activeness is decided
     * against the server clock ({@code startsAt <= now < expiresAt}); a scheduled or expired notice is
     * never returned.
     */
    @Transactional(readOnly = true)
    public List<Alert> activeGlobal() {
        return alerts.findActive(Alert.SCOPE_GLOBAL, now());
    }

    /**
     * The full history — every alert ever created, newest-first, for the admin list. The caller derives
     * each row's {@link AlertStatus} with {@link #now()} so the whole list is stamped against one
     * consistent instant.
     */
    @Transactional(readOnly = true)
    public List<Alert> history() {
        return alerts.findAllByOrderByCreatedAtDescIdDesc();
    }

    /**
     * Compose + schedule a global alert. {@code createdBy} is the verified admin uid (attribution).
     * {@code startsAt} defaults to {@link #now()} when omitted (show immediately). The window ordering
     * ({@code startsAt < expiresAt}) is validated at the edge ({@code CreateAlertRequest}) so this never
     * persists a malformed window.
     */
    @Transactional
    public Alert create(
            String createdBy,
            String message,
            AlertLevel level,
            AlertDismissal dismissal,
            Instant startsAt,
            Instant expiresAt) {
        Instant effectiveStart = startsAt != null ? startsAt : now();
        return alerts.save(new Alert(message, level, dismissal, effectiveStart, expiresAt, createdBy));
    }

    /**
     * Expire an alert now — pull a live (or scheduled) banner early by bringing {@code expiresAt}
     * forward to the server's current instant. An unknown id is a {@code 404}
     * ({@link ResourceNotFoundException}); re-expiring an already-expired alert is a harmless no-op that
     * keeps its original end (see {@link Alert#expireNow(Instant)}).
     */
    @Transactional
    public Alert expireNow(long id) {
        Alert alert = alerts.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("No alert with id " + id));
        alert.expireNow(now());
        return alerts.save(alert);
    }
}
