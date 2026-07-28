package com.teammarhaba.backend.web;

/**
 * Thrown when an admin PATCH tries to CHANGE a profile field that an admin may only VIEW, not edit
 * (TM-1109). Today that is the user's own {@code notificationPref} — the notification preference is
 * the user's personal delivery choice, so the admin console renders it read-only and the admin
 * profile endpoint refuses to mutate it. The user's OWN self-edit ({@code PATCH /api/v1/me}) still
 * changes it; only the admin-on-behalf path is blocked.
 *
 * <p>Mapped to a {@code 422 Unprocessable Entity} RFC 7807 response by {@link GlobalExceptionHandler}:
 * the request is well-formed (a valid enum value parsed fine at the boundary) but not permitted — the
 * admin is asking for a change the endpoint deliberately does not allow. A no-op (re-sending the
 * value already stored) or omitting the field is fine and never throws.
 */
public class AdminImmutableFieldException extends RuntimeException {

    public AdminImmutableFieldException(String message) {
        super(message);
    }
}
