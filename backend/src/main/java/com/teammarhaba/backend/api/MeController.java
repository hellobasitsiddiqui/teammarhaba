package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Returns the verified caller's identity at {@code GET /api/v1/me} (the {@code /api/v1} prefix is
 * applied by {@link ApiV1Config}). It lets a client confirm end-to-end auth and render "who am I"
 * from the server's reading of the token, rather than trusting the client's own decoded copy.
 *
 * <p>Reaching it requires a verified Firebase ID token (TM-79, default-deny): an anonymous or
 * invalid token is rejected with a uniform RFC 7807 {@code 401} before this handler runs, so the
 * {@link VerifiedUser} principal is always present here.
 *
 * <p>{@code role} is a fixed {@code USER} until RBAC (2.3) lands, and {@code displayName} is
 * {@code null} until the {@link VerifiedUser} principal carries the token's {@code name} claim.
 */
@RestController
public class MeController {

    /** Default role for every caller until RBAC (2.3) introduces real roles/claims. */
    private static final String DEFAULT_ROLE = "USER";

    @GetMapping("/me")
    MeResponse me(@AuthenticationPrincipal VerifiedUser user) {
        return new MeResponse(user.uid(), user.email(), null, DEFAULT_ROLE);
    }
}
