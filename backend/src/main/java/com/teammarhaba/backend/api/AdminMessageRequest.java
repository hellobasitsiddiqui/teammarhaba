package com.teammarhaba.backend.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.teammarhaba.backend.messaging.AudienceSpec;
import com.teammarhaba.backend.messaging.TargetType;
import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Body for {@code POST /api/v1/admin/messages} (TM-441, epic TM-432). An admin sends a {@code title} +
 * {@code body} (+ optional deep-link) to a <em>resolved audience</em> — one of: explicit
 * {@code userIds}, one-or-more {@code cities}, or one-or-more {@code eventIds} (their {@code GOING}
 * attendees). The backend resolves the audience, delivers a durable inbox notification per recipient
 * and fans out a best-effort push.
 *
 * <p>Everything a client controls is bounded by Bean Validation so a malformed body is a uniform
 * RFC-7807 {@code 400} (with per-field {@code errors[]}) rather than a {@code 500}, mirroring
 * {@link CreateEventRequest} / {@link BroadcastPushRequest}:
 *
 * <ul>
 *   <li>{@code title} — required, non-blank, max {@value #MAX_TITLE_LENGTH} (the admin-message title
 *       cap; the {@code admin_message.title} column has headroom);</li>
 *   <li>{@code body} — required, non-blank, max {@value #MAX_BODY_LENGTH} (an in-app message is much
 *       longer than a push blast — see TM-441's ~5000-char clarification);</li>
 *   <li>{@code deepLink} — optional. {@code null} = no deep-link; a non-null value is validated against
 *       the app's known routes ({@code PushRoutes}) in the service and an off-list route is a clean
 *       {@code 400}, so it is intentionally <em>not</em> constrained here;</li>
 *   <li>{@code userIds} / {@code cities} / {@code eventIds} — the three audience dimensions, each
 *       optional and each capped ({@value #MAX_USER_IDS} / {@value #MAX_CITIES} /
 *       {@value #MAX_EVENT_IDS}). <b>Exactly one</b> must be non-empty ({@link #isExactlyOneTargetType()}):
 *       a send targets one type, not a combination (the product rule; the resolver could union them,
 *       but the endpoint deliberately does not).</li>
 * </ul>
 *
 * @param title    the message headline; required, non-blank, bounded
 * @param body     the message body; required, non-blank, bounded (up to ~5000 chars)
 * @param deepLink an optional in-app hash route to deep-link to on tap ({@code null} = none);
 *                 validated against the allow-list in the service
 * @param userIds  explicit target account ids (one of the three dimensions); each non-null, capped
 * @param cities   target profile cities (one of the three dimensions); each non-blank, capped
 * @param eventIds target events whose {@code GOING} attendees to reach (one of the three); capped
 */
public record AdminMessageRequest(
        @NotBlank @Size(max = MAX_TITLE_LENGTH) String title,
        @NotBlank @Size(max = MAX_BODY_LENGTH) String body,
        String deepLink,
        @Size(max = MAX_USER_IDS) List<@NotNull Long> userIds,
        @Size(max = MAX_CITIES) List<@NotBlank String> cities,
        @Size(max = MAX_EVENT_IDS) List<@NotNull Long> eventIds) {

    /** Max title length — the admin-message title cap (the column has headroom). */
    public static final int MAX_TITLE_LENGTH = 120;

    /** Max body length — an in-app admin message, much longer than a push blast (TM-441 clarification). */
    public static final int MAX_BODY_LENGTH = 5000;

    /** Hard cap on explicit recipient ids per send — one call can't target an unbounded id list. */
    public static final int MAX_USER_IDS = 500;

    /** Hard cap on cities per send. */
    public static final int MAX_CITIES = 50;

    /** Hard cap on events per send. */
    public static final int MAX_EVENT_IDS = 50;

    /**
     * Exactly one audience dimension must be targeted — a send picks one target type, not a
     * combination. {@code @AssertTrue} so a violation (none, or more than one) surfaces through the
     * standard RFC-7807 validation body, like {@link CreateEventRequest}'s cross-field rules.
     */
    @JsonIgnore
    @AssertTrue(message = "Provide exactly one target type: userIds, cities, or eventIds.")
    public boolean isExactlyOneTargetType() {
        int dimensions = 0;
        if (isPresent(userIds)) {
            dimensions++;
        }
        if (isPresent(cities)) {
            dimensions++;
        }
        if (isPresent(eventIds)) {
            dimensions++;
        }
        return dimensions == 1;
    }

    /**
     * Which single dimension this request targets. Only meaningful once {@link #isExactlyOneTargetType()}
     * has passed (i.e. after {@code @Valid}); the controller calls it on a validated request.
     */
    @JsonIgnore
    public TargetType targetType() {
        if (isPresent(userIds)) {
            return TargetType.USER;
        }
        if (isPresent(cities)) {
            return TargetType.CITY;
        }
        return TargetType.EVENT;
    }

    /** Build the {@link AudienceSpec} for the single targeted dimension (post-validation). */
    @JsonIgnore
    public AudienceSpec toAudienceSpec() {
        return switch (targetType()) {
            case USER -> AudienceSpec.users(userIds);
            case CITY -> AudienceSpec.cities(cities);
            case EVENT -> AudienceSpec.events(eventIds);
        };
    }

    /**
     * A human-readable descriptor of the target for the campaign header / sent-history view (the id
     * CSV, or the city name(s)). Bounded to the {@code admin_message.target_ref} column width — the
     * exact recipient membership is always recoverable from the per-recipient notifications, so a very
     * long id list is truncated here without losing anything material.
     */
    @JsonIgnore
    public String targetRef() {
        String ref = switch (targetType()) {
            case USER -> userIds.stream().map(String::valueOf).collect(Collectors.joining(","));
            case CITY -> String.join(",", cities);
            case EVENT -> eventIds.stream().map(String::valueOf).collect(Collectors.joining(","));
        };
        return ref.length() <= MAX_TARGET_REF_LENGTH ? ref : ref.substring(0, MAX_TARGET_REF_LENGTH - 1) + "…";
    }

    /** Column width of {@code admin_message.target_ref}; the descriptor is truncated to fit. */
    private static final int MAX_TARGET_REF_LENGTH = 1024;

    private static boolean isPresent(List<?> list) {
        return list != null && !list.isEmpty();
    }
}
