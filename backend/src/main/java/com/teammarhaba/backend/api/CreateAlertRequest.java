package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.alert.AlertDismissal;
import com.teammarhaba.backend.alert.AlertLevel;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import org.springframework.util.StringUtils;

/**
 * Body for {@code POST /api/v1/admin/alerts} (TM-243) — compose + schedule a global alert. Everything a
 * client controls is bounded by Bean Validation so a malformed request is a uniform RFC-7807
 * {@code 400} (with per-field {@code errors[]}) rather than a {@code 500}, mirroring
 * {@link BroadcastPushRequest}:
 *
 * <ul>
 *   <li>{@code message} — required, non-blank, max {@value #MAX_MESSAGE_LENGTH} (fits the
 *       {@code alert.message} column). A public broadcast, so it must never carry sensitive data.
 *   <li>{@code level} — required ({@link AlertLevel}); drives the banner colour.
 *   <li>{@code dismissal} — required ({@link AlertDismissal}); tells the web which dismiss control to
 *       render.
 *   <li>{@code startsAt} — optional; omitted = show immediately (the service defaults it to "now").
 *   <li>{@code expiresAt} — required; when the banner auto-hides.
 * </ul>
 *
 * <p>The cross-field rule — the schedule window must be ordered ({@code startsAt < expiresAt}) — is an
 * {@code @AssertTrue} property so a bad window surfaces through the same validation body. {@code scope}
 * is not a request field: the MVP only sends {@code global}, so the service fixes it.
 *
 * @param message the notice text; required, non-blank, bounded
 * @param level the severity; required
 * @param dismissal the dismissal behaviour; required
 * @param startsAt when it becomes visible; omitted = now
 * @param expiresAt when it auto-hides; required
 */
public record CreateAlertRequest(
        @NotNull @Size(min = 1, max = MAX_MESSAGE_LENGTH) String message,
        @NotNull AlertLevel level,
        @NotNull AlertDismissal dismissal,
        Instant startsAt,
        @NotNull Instant expiresAt) {

    /** Max message length — fits the {@code alert.message} column; MVP notices are kept short. */
    public static final int MAX_MESSAGE_LENGTH = 500;

    /**
     * The message must carry real content — reject a blank/whitespace-only notice. Kept as an
     * {@code @AssertTrue} (rather than {@code @NotBlank}) so a null message is reported by
     * {@code @NotNull} alone (one error, not two).
     */
    @JsonIgnore
    @AssertTrue(message = "message must not be blank")
    public boolean isMessagePresent() {
        return message == null || StringUtils.hasText(message);
    }

    /**
     * The schedule window must be ordered: the effective start (given {@code startsAt}, or "now" when
     * omitted — approximated here as "not after expiry") must be strictly before {@code expiresAt}. When
     * {@code startsAt} is omitted the service uses the server clock, which is well before any sane
     * future {@code expiresAt}; this rule only guards an explicitly-supplied, out-of-order window.
     */
    @JsonIgnore
    @AssertTrue(message = "startsAt must be before expiresAt")
    public boolean isWindowOrdered() {
        return startsAt == null || expiresAt == null || startsAt.isBefore(expiresAt);
    }
}
