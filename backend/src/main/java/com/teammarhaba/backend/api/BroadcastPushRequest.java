package com.teammarhaba.backend.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * Body for {@code POST /api/v1/admin/push/broadcast} (TM-363, epic TM-358). An admin sends a custom
 * push — a {@code title} + {@code body} (+ optional deep-link {@code route}) — to a chosen set of
 * accounts identified by {@code userIds}, and the backend fans it out to each recipient's devices.
 *
 * <p>Everything a client controls is bounded by Bean Validation so a malformed request is a uniform
 * RFC-7807 {@code 400} (with per-field {@code errors[]}) rather than a {@code 500}, mirroring
 * {@link RegisterDeviceRequest}:
 *
 * <ul>
 *   <li>{@code userIds} — a non-empty list ({@code @NotEmpty}) of non-null ids ({@code @NotNull}
 *       elements), capped at {@value #MAX_RECIPIENTS} ({@code @Size}) so one call can't target an
 *       unbounded audience (the batched multi-recipient path is a future optimisation, TM-363 notes);</li>
 *   <li>{@code title} — required, non-blank, max {@value #MAX_TITLE_LENGTH} (fits the
 *       {@code notification_broadcasts.title} column and matches the {@link PushMessage} guard);</li>
 *   <li>{@code body} — required, non-blank, max {@value #MAX_BODY_LENGTH};</li>
 *   <li>{@code route} — optional. {@code null} = no deep-link; a non-null value is validated against the
 *       app's known routes ({@code PushRoutes}) in the service and an off-list route is a clean
 *       {@code 400}, so it is intentionally <em>not</em> constrained here.</li>
 * </ul>
 *
 * @param userIds the {@code users.id} values to deliver to; non-empty, each non-null, capped
 * @param title   the notification headline; required, non-blank, bounded
 * @param body    the notification body; required, non-blank, bounded
 * @param route   an optional in-app hash route to deep-link to on tap ({@code null} = no deep-link);
 *                validated against the allow-list in the service
 */
public record BroadcastPushRequest(
        @NotEmpty @Size(max = MAX_RECIPIENTS) List<@NotNull Long> userIds,
        @NotBlank @Size(max = MAX_TITLE_LENGTH) String title,
        @NotBlank @Size(max = MAX_BODY_LENGTH) String body,
        String route) {

    /** Hard cap on recipients per broadcast — one call can't target an unbounded audience. */
    public static final int MAX_RECIPIENTS = 500;

    /** Max title length — fits {@code notification_broadcasts.title} and the {@link PushMessage} guard. */
    public static final int MAX_TITLE_LENGTH = 200;

    /** Max body length — comfortably within the {@code notification_broadcasts.body} column. */
    public static final int MAX_BODY_LENGTH = 1000;
}
