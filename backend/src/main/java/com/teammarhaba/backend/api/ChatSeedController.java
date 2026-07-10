package com.teammarhaba.backend.api;

import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.testsupport.ChatSeedService;
import io.swagger.v3.oas.annotations.Hidden;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * TEST-ONLY chat seed endpoint (TM-587) — {@code POST /api/v1/test/chat/seed} (the {@code /api/v1}
 * prefix is applied by {@link ApiV1Config}). It populates the signed-in caller's chat with a couple
 * of event group threads + an admin "from TeamMarhaba" channel, each with messages and unread state,
 * so the Event Chat foundation screens can be rendered/asserted against a <em>live</em> backend
 * instead of the route-mocked fixtures the TM-564 evidence had to use. See {@link ChatSeedService}.
 *
 * <p><b>Never in production.</b> This controller and its service are gated two ways —
 * {@link Profile}{@code ("!prod")} <em>and</em>
 * {@link ConditionalOnProperty}{@code (app.test-seed.enabled=true)} (base default {@code false}, so
 * prod, which never sets it, has no bean). It is also {@link Hidden} from the OpenAPI spec, so the
 * generated {@code openapi.json} / public docs never advertise a test-only surface even in the dev/test
 * profiles where springdoc is on. {@code ChatSeedDisabledIntegrationTest} proves the bean is absent
 * when the flag is off (as prod inherits it).
 *
 * <p>Like the rest of the {@code /api/v1} surface it requires a signed-in caller (default-deny 401
 * otherwise); identity is the verified {@link VerifiedUser} principal, never the client, so a caller
 * only ever seeds their own chat. Idempotent — a re-seed of an already-seeded account is a no-op.
 */
@RestController
@Hidden
@Profile("!prod")
@ConditionalOnProperty(prefix = "app.test-seed", name = "enabled", havingValue = "true")
public class ChatSeedController {

    private final ChatSeedService seed;

    ChatSeedController(ChatSeedService seed) {
        this.seed = seed;
    }

    /** Seed (idempotently) the caller's chat; returns the resulting thread + unread tallies. */
    @PostMapping("/test/chat/seed")
    ChatSeedService.ChatSeedResult seed(@AuthenticationPrincipal VerifiedUser caller) {
        return seed.seed(caller);
    }
}
