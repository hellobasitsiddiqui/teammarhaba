package com.teammarhaba.backend.web;

/**
 * Thrown when a user with real-world event history tries to CHANGE an already-set first/last/display
 * name (TM-907). Mapped to a {@code 422 Unprocessable Entity} RFC 7807 response by
 * {@link GlobalExceptionHandler} with a <em>distinct</em> problem {@code type}
 * ({@code .../name-locked}) and a stable {@code detail} the web keys on to render the name fields
 * read-only rather than showing a raw error — matching the codebase's immutable-field / not-allowed
 * convention (422, like {@link SelfActionNotAllowedException}).
 *
 * <p><b>Not raised for setting a currently-EMPTY name.</b> The lock forbids changing a name that is
 * already set; a locked user whose first/last is blank (they attended with only a displayName) may
 * still SET it once — the same "seed only when unset" carve-out onboarding uses — so the lock never
 * creates an unfixable empty-name profile-strength gap. That carve-out is enforced by the caller
 * ({@code UserService}); this exception fires only on a genuine change of a set value.
 */
public class NameLockedException extends RuntimeException {

    /**
     * The stable, distinct detail message the web keys on (alongside the {@code type} URI) to switch
     * the name fields to read-only. Kept as a constant so the server copy and any client/test that
     * asserts it share one source of truth.
     */
    public static final String DETAIL =
            "Your name is locked because you have event history — contact support to correct it.";

    public NameLockedException() {
        super(DETAIL);
    }
}
