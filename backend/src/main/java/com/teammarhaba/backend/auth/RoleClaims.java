package com.teammarhaba.backend.auth;

import com.teammarhaba.backend.user.Role;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

/**
 * The {@code role} Firebase custom claim and its mapping to a Spring authority (TM-110).
 *
 * <p>The token is the source of truth for the caller's role: the Admin SDK writes a {@code role}
 * custom claim ({@link #CLAIM}) — see {@link RoleService} — and {@link FirebaseAuthenticationFilter}
 * turns it into a {@code ROLE_*} {@link GrantedAuthority} so the rest of the app can authorize with
 * Spring Security (e.g. {@code @PreAuthorize("hasRole('ADMIN')")} in TM-111). Parsing is lenient and
 * <strong>fails safe to {@link Role#USER}</strong>: a missing, blank, or unrecognised claim never
 * grants elevated access. The persisted {@code users.role} column mirrors this for reporting; the
 * claim, not the row, drives authorization.
 */
public final class RoleClaims {

    /** Custom-claim key carried on the Firebase ID token. */
    public static final String CLAIM = "role";

    private RoleClaims() {}

    /**
     * Resolve the role from a token's (or user record's) custom claims, defaulting to
     * {@link Role#USER} when the claim is absent, blank, or not a recognised role.
     */
    public static Role roleFrom(Map<String, Object> claims) {
        if (claims == null) {
            return Role.USER;
        }
        Object raw = claims.get(CLAIM);
        if (raw == null) {
            return Role.USER;
        }
        try {
            return Role.valueOf(raw.toString().trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException unknownRole) {
            return Role.USER;
        }
    }

    /** The Spring authorities granted for a role — {@code ROLE_USER} / {@code ROLE_ADMIN}. */
    public static Collection<GrantedAuthority> authorities(Role role) {
        return List.of(new SimpleGrantedAuthority("ROLE_" + role.name()));
    }
}
