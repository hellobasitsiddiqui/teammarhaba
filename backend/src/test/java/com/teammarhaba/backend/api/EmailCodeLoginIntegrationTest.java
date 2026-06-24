package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.EmailCodeMailer;
import com.teammarhaba.backend.auth.EmailCodeProperties;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * {@code POST /api/v1/auth/email-code/request|verify} (TM-234) end-to-end through the real security
 * chain (the routes are permit-listed, so no token is needed) and the real {@code EmailCodeService},
 * with a mocked {@link FirebaseAuth} standing in for the Admin SDK and a capturing
 * {@link EmailCodeMailer} so the test can read the issued code.
 *
 * <p>Covers: the happy path (request 204 → verify 200 with a custom token); the existing
 * email+password path is unaffected (this is purely additive — no migration); a wrong code is a 401;
 * the send cooldown turns a rapid second request into a 429; and a malformed body is a 400.
 */
@AutoConfigureMockMvc
@Import(EmailCodeLoginIntegrationTest.CapturingMailerConfig.class)
class EmailCodeLoginIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private CapturingMailer mailer;

    @MockBean
    private FirebaseAuth firebaseAuth;

    /** A distinct address per test so the process-wide send cooldown can't couple tests. */
    private String requestCodeFor(String who) throws Exception {
        String email = who + "@example.com";
        mockMvc.perform(post("/api/v1/auth/email-code/request")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\"}"))
                .andExpect(status().isNoContent());
        return email;
    }

    private void stubFirebaseUser(String email, String uid, String token) throws Exception {
        UserRecord record = org.mockito.Mockito.mock(UserRecord.class);
        when(record.getUid()).thenReturn(uid);
        when(firebaseAuth.getUserByEmail(email)).thenReturn(record);
        when(firebaseAuth.createCustomToken(uid)).thenReturn(token);
    }

    @Test
    void happyPath_requestThenVerifyReturnsACustomToken() throws Exception {
        String email = requestCodeFor("happy");
        stubFirebaseUser(email, "uid-happy", "tok-happy");
        String code = mailer.codes.get(email);
        assertThat(code).matches("\\d{6}");

        String json = mockMvc.perform(post("/api/v1/auth/email-code/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"code\":\"" + code + "\"}"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        JsonNode node = objectMapper.readTree(json);
        assertThat(node.get("customToken").asText()).isEqualTo("tok-happy");
    }

    @Test
    void wrongCodeIsRejectedWith401() throws Exception {
        String email = requestCodeFor("wrong");
        stubFirebaseUser(email, "uid-wrong", "tok-wrong");

        mockMvc.perform(post("/api/v1/auth/email-code/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"code\":\"000000\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.status").value(401));
    }

    @Test
    void rapidSecondRequestHitsTheSendCooldownAndGets429() throws Exception {
        String email = "burst@example.com";
        mockMvc.perform(post("/api/v1/auth/email-code/request")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\"}"))
                .andExpect(status().isNoContent());

        mockMvc.perform(post("/api/v1/auth/email-code/request")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\"}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.status").value(429));
    }

    @Test
    void perIpRequestFloodHits429RegardlessOfDistinctAddresses(@Autowired EmailCodeProperties props)
            throws Exception {
        // The varied-address DoS the per-address cooldown can't catch (TM-247): every call uses a
        // DISTINCT address (so the send cooldown never fires) but the SAME spoofed client IP via
        // X-Forwarded-For. After ipRequestLimit calls the coarse per-IP limit returns 429. A unique
        // forwarded IP keeps this test's budget independent of the other tests' 127.0.0.1 traffic.
        String floodIp = "198.18.0.99";
        int limit = props.ipRequestLimit();

        for (int i = 0; i <= limit; i++) {
            var result = mockMvc.perform(post("/api/v1/auth/email-code/request")
                            .header("X-Forwarded-For", floodIp)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"email\":\"ipflood-" + i + "@example.com\"}"))
                    .andReturn();
            int statusCode = result.getResponse().getStatus();
            if (i < limit) {
                assertThat(statusCode).isEqualTo(204); // within budget
            } else {
                assertThat(statusCode).isEqualTo(429); // the (limit+1)-th trips the per-IP limit
                assertThat(result.getResponse().getContentType())
                        .contains(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
            }
        }
    }

    @Test
    void malformedBodyIsRejectedWith400() throws Exception {
        // Missing/blank email fails Bean Validation -> 400 (request endpoint).
        mockMvc.perform(post("/api/v1/auth/email-code/request")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"not-an-email\"}"))
                .andExpect(status().isBadRequest());

        // A non-numeric code fails the @Pattern -> 400 (verify endpoint).
        mockMvc.perform(post("/api/v1/auth/email-code/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"x@example.com\",\"code\":\"abc\"}"))
                .andExpect(status().isBadRequest());
    }

    @TestConfiguration
    static class CapturingMailerConfig {
        // @Primary so it wins over the default LoggingEmailCodeMailer regardless of bean-ordering:
        // @ConditionalOnMissingBean can't reliably back off for a bean contributed by an @Import-ed
        // @TestConfiguration, so make the test mailer unambiguously the one injected.
        @Bean
        @org.springframework.context.annotation.Primary
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
