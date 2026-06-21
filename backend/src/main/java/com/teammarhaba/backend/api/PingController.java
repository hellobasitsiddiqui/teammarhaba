package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import java.util.Map;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * An authenticated probe under {@code /api/v1/ping} (the prefix is applied by
 * {@link ApiV1Config}). It exists to exercise — and document — the auth seam (TM-79): reaching
 * it requires a verified Firebase ID token, and it echoes the caller's identity, proving the
 * {@link VerifiedUser} principal is available to handlers.
 */
@RestController
public class PingController {

    @GetMapping("/ping")
    Map<String, String> ping(@AuthenticationPrincipal VerifiedUser user) {
        return Map.of(
                "uid", user.uid(),
                "email", user.email() == null ? "" : user.email());
    }
}
