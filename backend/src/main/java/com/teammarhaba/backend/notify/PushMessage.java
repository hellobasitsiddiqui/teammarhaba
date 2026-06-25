package com.teammarhaba.backend.notify;

/**
 * The user-visible content of a single push notification (TM-284, epic TM-277). Kept transport-neutral
 * (a {@code title} + {@code body}) so the {@link PushSender} seam can map it onto FCM today and onto
 * any future transport without the calling services knowing about the wire format.
 *
 * <p>An optional {@code route} (TM-290) carries a deep-link destination: when present, the sender puts
 * it into the FCM message's {@code data.route} so a notification tap navigates the app there (the
 * client side, TM-285). It is constrained to the app's known hash routes ({@link PushRoutes#KNOWN}) —
 * a {@code null} route means "no destination" (open the app as before), and a non-null-but-unknown
 * route is rejected here so an off-list/crafted route never reaches the wire. Callers that take a route
 * from untrusted input should validate it ({@link PushRoutes#isKnown}) and surface a clean 400 before
 * constructing the message; this constructor is the last-line guard.
 *
 * @param title the short headline shown on the notification
 * @param body  the longer line beneath the title
 * @param route an optional in-app hash route to deep-link to on tap ({@code null} = none); if non-null
 *              it must be one of {@link PushRoutes#KNOWN}
 */
public record PushMessage(String title, String body, String route) {

    public PushMessage {
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException("Push title must not be blank.");
        }
        if (body == null || body.isBlank()) {
            throw new IllegalArgumentException("Push body must not be blank.");
        }
        if (route != null && !PushRoutes.isKnown(route)) {
            throw new IllegalArgumentException(
                    "Push route '" + route + "' is not a known deep-link route. Allowed: " + PushRoutes.KNOWN);
        }
    }

    /** A message with no deep-link route — a tap just opens the app (the pre-TM-290 behaviour). */
    public PushMessage(String title, String body) {
        this(title, body, null);
    }
}
