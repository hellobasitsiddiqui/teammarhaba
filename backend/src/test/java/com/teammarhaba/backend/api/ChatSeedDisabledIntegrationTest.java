package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.TestcontainersConfiguration;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.testsupport.ChatSeedService;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * The prod-disabled guard for the TM-587 chat seed hook. This boots the context with {@code
 * app.test-seed.enabled=false} — <em>exactly what production does</em>: the base config defaults the
 * flag to {@code false} and the prod profile never turns it on. It proves that with the flag off the
 * seed surface simply does not exist: neither the {@link ChatSeedController} nor the {@link
 * ChatSeedService} bean is registered, and the endpoint is unmapped (a signed-in caller gets a
 * {@code 404}, so there is nothing to seed against, let alone in prod).
 *
 * <p>The seed beans additionally carry {@code @Profile("!prod")} as a second, independent guard — so
 * even a mis-set flag on the prod profile could not create them — but that can't be booted here (the
 * prod profile requires the full Cloud SQL / secret environment), so this test exercises the
 * property switch, which is the guard prod actually rides.
 *
 * <p>Its own context (a distinct property source from {@link com.teammarhaba.backend.AbstractIntegrationTest})
 * so it can't reuse the flag-on cached context the rest of the suite shares.
 */
@SpringBootTest
@ActiveProfiles("test")
@Import(TestcontainersConfiguration.class)
@TestPropertySource(properties = "app.test-seed.enabled=false")
@AutoConfigureMockMvc
class ChatSeedDisabledIntegrationTest {

    @Autowired
    private ApplicationContext context;

    @Autowired
    private MockMvc mockMvc;

    @Test
    void theSeedBeansAreAbsentWhenTheFlagIsOff() {
        assertThat(context.getBeanNamesForType(ChatSeedController.class))
                .as("ChatSeedController must not exist when app.test-seed.enabled is off (as in prod)")
                .isEmpty();
        assertThat(context.getBeanNamesForType(ChatSeedService.class))
                .as("ChatSeedService must not exist when app.test-seed.enabled is off (as in prod)")
                .isEmpty();
    }

    @Test
    void theSeedEndpointIsUnmappedWhenTheFlagIsOff() throws Exception {
        // Authenticated so this can't be mistaken for the default-deny 401 — a signed-in caller still
        // gets a 404 because the route does not exist when the flag is off.
        String uid = "chat-seed-disabled-" + UUID.randomUUID();
        mockMvc.perform(post("/api/v1/test/chat/seed")
                        .with(authentication(new UsernamePasswordAuthenticationToken(
                                new VerifiedUser(uid, uid + "@teammarhaba.test"), null, List.of()))))
                .andExpect(status().isNotFound());
    }
}
