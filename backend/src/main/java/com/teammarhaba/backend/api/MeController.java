package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/v1/me} — returns the verified caller (the prefix is applied by
 * {@link ApiV1Config}). It's the web app's "who am I" check that proves end-to-end auth:
 * reaching it requires a valid Firebase {@code Bearer} token, and an anonymous/invalid token
 * gets the uniform RFC 7807 {@code 401} from the security chain (default-deny).
 *
 * <p>Identity comes straight from the {@link VerifiedUser} principal established by the Epic-1
 * auth filter (TM-79) — no new auth mechanics. {@code displayName} is filled from the persisted
 * profile (TM-112) and {@code role} from the Firebase custom claim (TM-110); until those land it
 * returns {@code null} / {@code "USER"}.
 */
@RestController
public class MeController {

    private static final String DEFAULT_ROLE = "USER";

    @GetMapping("/me")
    MeResponse me(@AuthenticationPrincipal VerifiedUser user) {
        return new MeResponse(user.uid(), user.email(), null, DEFAULT_ROLE);
    }
}
