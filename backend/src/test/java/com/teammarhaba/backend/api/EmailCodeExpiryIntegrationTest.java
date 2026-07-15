package com.teammarhaba.backend.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.EmailCodeMailer;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * TM-738 P0 (auth): characterizes that an <em>expired</em> email-code login code surfaces as a
 * <strong>410 Gone</strong> at the HTTP boundary — the credential existed but is no longer valid,
 * "request a fresh one" — and is <strong>not conflated</strong> with the plain-wrong-code
 * <strong>401</strong> ({@code CODE_INVALID}). That distinction is a real behaviour the service goes
 * out of its way to preserve: {@code EmailCodeService} keeps a just-expired entry in its Caffeine
 * cache for {@code 2 × ttl} so {@code verify} can still see it and report {@code CODE_EXPIRED}
 * ({@code GlobalExceptionHandler} → 410) rather than dropping it and misreporting {@code CODE_INVALID}
 * (401). This asserts the full {@code EmailCodeController} + {@code GlobalExceptionHandler} path.
 *
 * <p>A short {@code ttl} (1s) is set for this context via {@link TestPropertySource} so real expiry
 * can be driven with a brief sleep — the app-context {@code EmailCodeService} uses the wall clock
 * (its advanceable-clock seam is package-private to {@code auth}, so we exercise time for real here).
 * The sleep lands the code <em>past</em> its 1s logical TTL but well inside the 2s cache-retention
 * window, which is exactly the "just-expired, still readable" state that yields 410 not 401. Separate
 * class (not folded into {@code EmailCodeLoginIntegrationTest}) because the short-TTL property forces
 * a distinct application context.
 */
@AutoConfigureMockMvc
@Import(EmailCodeExpiryIntegrationTest.CapturingMailerConfig.class)
@TestPropertySource(
        properties = {
            // Short TTL so real expiry is reachable with a brief sleep. The code is retained in-cache
            // for 2×ttl (2s) after issue, so a read between 1s and 2s is "expired but still readable" —
            // the state that must map to 410 (CODE_EXPIRED), never 401 (CODE_INVALID).
            "app.auth.email-code.ttl=1s",
            // Keep the send cooldown out of the way — this test never re-requests for one address, but a
            // short cooldown keeps the context self-consistent with the short TTL.
            "app.auth.email-code.send-cooldown=1s"
        })
class EmailCodeExpiryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private CapturingMailer mailer;

    @MockBean
    private FirebaseAuth firebaseAuth;

    @Test
    void verify_expiredCodeReturns410NotConflated() throws Exception {
        String email = "expiry@example.com";
        mockMvc.perform(post("/api/v1/auth/email-code/request")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\"}"))
                .andExpect(status().isNoContent());
        String code = mailer.codes.get(email);

        // Wait until the 1s TTL has elapsed but the entry is still cache-resident (< 2s). 1.4s gives a
        // comfortable margin on both sides so the code is unambiguously "expired but still readable".
        Thread.sleep(1400);

        // Expired credential -> 410 Gone (CODE_EXPIRED), the DISTINCT status. It must NOT be a 401
        // (CODE_INVALID) — that would mean the code was silently dropped and its expiry misreported as
        // "never valid", losing the actionable "request a fresh one" signal.
        mockMvc.perform(post("/api/v1/auth/email-code/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"code\":\"" + code + "\"}"))
                .andExpect(status().isGone())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.status").value(410));
    }

    @TestConfiguration
    static class CapturingMailerConfig {
        // @Primary so it wins over the default LoggingEmailCodeMailer (see EmailCodeLoginIntegrationTest).
        @Bean
        @Primary
        CapturingMailer capturingMailer() {
            return new CapturingMailer();
        }
    }

    /** Real {@link EmailCodeMailer} bean (overrides the logging default) that records issued codes. */
    static class CapturingMailer implements EmailCodeMailer {
        final ConcurrentHashMap<String, String> codes = new ConcurrentHashMap<>();

        @Override
        public void sendLoginCode(String email, String code) {
            codes.put(email, code);
        }
    }
}
