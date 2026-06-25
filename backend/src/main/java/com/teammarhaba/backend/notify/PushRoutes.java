package com.teammarhaba.backend.notify;

import java.util.Set;

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
 */
public final class PushRoutes {

    /**
     * The allowed deep-link destinations. Must stay in lock-step with {@code KNOWN_ROUTES} in
     * {@code web/src/assets/push-deeplink.js} (TM-285) — if a route is added/removed there, mirror it
     * here (and vice versa) so the backend never emits a route the client can't resolve.
     */
    public static final Set<String> KNOWN = Set.of(
            "#/home", "#/profile", "#/admin", "#/help", "#/onboarding", "#/login");

    private PushRoutes() {}

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
