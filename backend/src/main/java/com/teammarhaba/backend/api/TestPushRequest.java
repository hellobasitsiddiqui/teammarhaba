package com.teammarhaba.backend.api;

/**
 * Optional body for {@code POST /api/v1/admin/users/{id}/test-push} (TM-290). Lets an admin exercise
 * the deep-link path by choosing where a tap on the test notification should land.
 *
 * <p>The body is optional: with no body (or a {@code null} {@code route}) the endpoint sends a plain
 * test notification with no deep-link, exactly as before TM-290. When present, {@code route} must be
 * one of the app's known hash routes (e.g. {@code #/profile}); an unknown route is rejected with a
 * {@code 400} by the service ({@code PushRoutes} allow-list) rather than emitting an off-list route.
 *
 * @param route an optional in-app hash route to deep-link to on tap ({@code null} = no deep-link)
 */
public record TestPushRequest(String route) {}
