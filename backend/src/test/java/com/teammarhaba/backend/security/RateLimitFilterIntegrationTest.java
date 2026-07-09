package com.teammarhaba.backend.security;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * End-to-end coverage of the API rate limit (TM-158): with a tiny budget of 3 requests, the first
 * three requests from one client pass through and the fourth is refused with a uniform RFC 7807
 * {@code 429} + {@code Retry-After}. The {@code test} profile disables the limiter by default (so the
 * rest of the suite isn't throttled), so this class re-enables it with a small capacity via
 * {@link TestPropertySource}. A long refill period keeps the window from topping up mid-test.
 *
 * <p>Every test uses a distinct client key (a unique {@code uid} or {@code X-Forwarded-For} IP) so the
 * shared limiter state can't leak between methods regardless of execution order.
 */
@AutoConfigureMockMvc
@TestPropertySource(
        properties = {
            "app.rate-limit.enabled=true",
            "app.rate-limit.capacity=3",
            "app.rate-limit.refill-tokens=3",
            "app.rate-limit.refill-period=1m",
        })
class RateLimitFilterIntegrationTest extends AbstractIntegrationTest {

    private static final int LIMIT = 3;

    @Autowired
    private MockMvc mockMvc;

    /**
     * Backs the Firebase-owned account-state block on {@code GET /me} (TM-164). Left unstubbed here —
     * the lookup then degrades to an all-null state, so an authenticated {@code GET /me} still returns
     * 200 and we can assert the under-limit "passes" case cleanly.
     */
    @MockBean
    private FirebaseAuth firebaseAuth;

    private static RequestPostProcessor caller(String uid) {
        return authentication(
                new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, uid + "@example.test"), null, List.of()));
    }

    @Test
    void authenticatedClientPassesUnderLimitThenGets429() throws Exception {
        RequestPostProcessor user = caller("rl-authed-user");

        // Under the limit: every request reaches the endpoint and succeeds (keyed by uid).
        for (int i = 0; i < LIMIT; i++) {
            mockMvc.perform(get("/api/v1/me").with(user)).andExpect(status().isOk());
        }

        // One over: refused before the controller, with the standard problem body + Retry-After.
        mockMvc.perform(get("/api/v1/me").with(user))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().exists(HttpHeaders.RETRY_AFTER))
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.status").value(429))
                .andExpect(jsonPath("$.title").value("Too many requests"))
                .andExpect(jsonPath("$.detail").isNotEmpty());
    }

    @Test
    void anonymousClientIsThrottledByIp() throws Exception {
        String ip = "203.0.113.7";

        // Anonymous /api/** requests still count against the limit; under it they reach the security
        // chain and get the normal 401 (no token), proving the limiter isn't what's rejecting them yet.
        for (int i = 0; i < LIMIT; i++) {
            mockMvc.perform(get("/api/v1/me").header("X-Forwarded-For", ip)).andExpect(status().isUnauthorized());
        }

        // Over the limit the rate-limit filter short-circuits with 429 before auth is even evaluated.
        mockMvc.perform(get("/api/v1/me").header("X-Forwarded-For", ip))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().exists(HttpHeaders.RETRY_AFTER));
    }

    @Test
    void healthAndProbesAreExemptFromTheLimit() throws Exception {
        // /health + the readiness/liveness probes sit outside /api/**, so no amount of hammering trips
        // the limit — a throttled abuser must never be able to knock the instance out of rotation.
        for (int i = 0; i < LIMIT * 3; i++) {
            mockMvc.perform(get("/health")).andExpect(status().isOk());
            mockMvc.perform(get("/actuator/health/readiness")).andExpect(status().isOk());
        }
    }

    @Test
    void separateClientsHaveIndependentBudgets() throws Exception {
        // Exhaust one user...
        RequestPostProcessor exhausted = caller("rl-user-b");
        for (int i = 0; i < LIMIT; i++) {
            mockMvc.perform(get("/api/v1/me").with(exhausted)).andExpect(status().isOk());
        }
        mockMvc.perform(get("/api/v1/me").with(exhausted)).andExpect(status().isTooManyRequests());

        // ...a different user still has their own full budget.
        mockMvc.perform(get("/api/v1/me").with(caller("rl-user-c"))).andExpect(status().isOk());
    }
}
