package com.teammarhaba.backend.notify;

import java.util.Set;
import java.util.regex.Pattern;

/**
 * The in-app hash routes a push notification is allowed to deep-link to (TM-290, epic TM-277).
 *
 * <p>This is the backend half of the deep-link allow-list. It deliberately <strong>mirrors</strong>
 * the client allow-list {@code KNOWN_ROUTES} in {@code web/src/assets/push-deeplink.js} (TM-285): the
 * send-push path only ever puts one of these values into the FCM message's {@code data.route}, and the
 * client only ever navigates to one of these on tap. Keeping the two lists identical means a route the
 * backend emits is always one the client can resolve — and an unknown/crafted route is rejected here
 * before it ever leaves the server, rather than relying solely on the client's own re-validation.
 *
 * <p>Only same-app hash routes ({@code #/...}) are listed; there is intentionally no way to emit an
 * absolute or external URL, so a route can never redirect the WebView off-origin.
 *
 * <p>Besides the exact {@link #KNOWN} set there is one allow-listed route <em>pattern</em>
 * ({@link #EVENT_DETAIL}, TM-394): parameterised routes like {@code #/events/42} that server code
 * builds via {@link #eventDetail} and that only the message-level guard ({@link #isAllowed})
 * accepts — admin input stays validated against the exact set.
 */
public final class PushRoutes {

    /**
     * The allowed deep-link destinations. Must stay in lock-step with {@code KNOWN_ROUTES} in
     * {@code web/src/assets/push-deeplink.js} (TM-285) — if a route is added/removed there, mirror it
     * here (and vice versa) so the backend never emits a route the client can't resolve.
     */
    public static final Set<String> KNOWN = Set.of(
            "#/home", "#/profile", "#/admin", "#/help", "#/onboarding", "#/login");

    /**
     * The one allow-listed route <em>pattern</em> (TM-394, on the TM-360 mechanism): the event
     * detail deep link {@code #/events/{id}}, where {@code {id}} is a positive decimal database id
     * (no sign, no leading zero, bounded to a positive Long's 19 digits — exactly what
     * {@link #eventDetail} emits and nothing more). Patterns are deliberately separate from {@link #KNOWN}: the exact
     * set stays the admin-facing picker/validation contract ({@link #isKnown} is unchanged), while
     * pattern routes are only constructible by server code via the {@link #eventDetail} builder
     * and accepted by the {@link #isAllowed} last-line guard.
     *
     * <p>Lock-step note: the client allow-list ({@code web/src/assets/push-deeplink.js}) does not
     * recognise this pattern yet — until the events web view lands and mirrors it, a tap on an
     * event reminder falls back to the client's {@code DEFAULT_ROUTE}. The payload already carries
     * the canonical route, so no backend change is needed when the client catches up.
     */
    static final Pattern EVENT_DETAIL = Pattern.compile("#/events/[1-9][0-9]{0,18}");

    private PushRoutes() {}

    /**
     * Build the event-detail deep link for {@code eventId} — the only way server code should form
     * one, so every emitted value matches {@link #EVENT_DETAIL} by construction.
     *
     * @param eventId the {@code events.id} to link to (must be positive)
     * @return the {@code #/events/{id}} hash route
     */
    public static String eventDetail(long eventId) {
        if (eventId <= 0) {
            throw new IllegalArgumentException("Event id for a deep link must be positive: " + eventId);
        }
        return "#/events/" + eventId;
    }

    /** Whether {@code route} matches the event-detail pattern (exact, whole-string match). */
    public static boolean isEventDetail(String route) {
        return route != null && EVENT_DETAIL.matcher(route).matches();
    }

    /**
     * Whether {@code route} may be emitted in a push at all: a {@link #KNOWN} exact route or an
     * allow-listed pattern route ({@link #isEventDetail}). This is what {@code PushMessage}'s
     * last-line guard checks; admin-supplied input keeps validating against the stricter
     * {@link #isKnown}.
     */
    public static boolean isAllowed(String route) {
        return isKnown(route) || isEventDetail(route);
    }

    /**
     * Whether {@code route} is one of the app's known deep-link destinations. A {@code null} route is
     * "no destination" (the message simply carries no {@code data.route}); only a non-null value is
     * checked against the allow-list.
     *
     * @param route the candidate hash route (may be {@code null})
     * @return {@code true} if {@code route} is non-null and on the allow-list
     */
    public static boolean isKnown(String route) {
        return route != null && KNOWN.contains(route);
    }
}
