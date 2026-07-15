package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
 *
 * <p>TM-738 P0 (auth) characterization adds: attempt-exhaustion surfaces as a distinct 429
 * (not conflated with the wrong-code 401); {@code request} never enumerates accounts (same 204 +
 * empty body for a known and an unknown address); and the emulator-only code-peek endpoint is closed
 * (404, never a 200 code leak) when {@code FIREBASE_AUTH_EMULATOR_HOST} is unset — the normal boot.
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
        // DISTINCT address (so the send cooldown never fires) but the SAME client IP. After
        // ipRequestLimit calls the coarse per-IP limit returns 429. The forwarded header mirrors the real
        // Cloud Run shape "<client>, <cloud-run-hop>" (TM-732: the client IP is the entry the trusted
        // proxy appended, counted from the right — NOT the spoofable leftmost), and the unique client IP
        // keeps this test's budget independent of the other tests' traffic.
        String floodIp = "198.18.0.99";
        String forwardedFor = floodIp + ", 130.211.0.1"; // client, then the Cloud Run front-end hop
        int limit = props.ipRequestLimit();

        for (int i = 0; i <= limit; i++) {
            var result = mockMvc.perform(post("/api/v1/auth/email-code/request")
                            .header("X-Forwarded-For", forwardedFor)
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
    void verify_attemptExhaustionReturns429VerifyRateLimited() throws Exception {
        // TM-738 P0 (auth): characterize the attempt-cap at the HTTP boundary. A short numeric code is
        // brute-forceable, so EmailCodeService burns the outstanding code after maxVerifyAttempts wrong
        // guesses (default 5). Crucially the exhausted state must surface as a DISTINCT status — 429
        // (VERIFY_RATE_LIMITED) — not conflated with the plain-wrong-code 401 (CODE_INVALID), so the
        // client can tell "try again" from "you're locked out, request a new code". This asserts the
        // real controller + GlobalExceptionHandler mapping (VERIFY_RATE_LIMITED -> 429).
        String email = requestCodeFor("exhaust");
        stubFirebaseUser(email, "uid-exhaust", "tok-exhaust");
        String correct = mailer.codes.get(email);
        // A guaranteed-wrong 6-digit code (differs from the real one in its first digit).
        String wrong = (correct.charAt(0) == '0' ? '1' : '0') + correct.substring(1);

        // The default budget is 5. The first 4 wrong guesses are a plain 401 (still tries left)...
        for (int i = 0; i < 4; i++) {
            mockMvc.perform(post("/api/v1/auth/email-code/verify")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"email\":\"" + email + "\",\"code\":\"" + wrong + "\"}"))
                    .andExpect(status().isUnauthorized())
                    .andExpect(jsonPath("$.status").value(401));
        }
        // ...the 5th wrong guess spends the last attempt and BURNS the code -> 429, a different status.
        mockMvc.perform(post("/api/v1/auth/email-code/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"code\":\"" + wrong + "\"}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.status").value(429));

        // The code is genuinely burned: even the CORRECT code no longer works (it reads as no
        // outstanding code -> 401), so no token can be minted after exhaustion.
        mockMvc.perform(post("/api/v1/auth/email-code/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"code\":\"" + correct + "\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.status").value(401));
    }

    @Test
    void request_neverEnumeratesAccounts_sameOutcomeForKnownAndUnknownEmail() throws Exception {
        // TM-738 P0 (auth): the request endpoint must not be a user-enumeration oracle. Whether the
        // address already has a Firebase account or not, a (non-rate-limited) request returns the SAME
        // 204 No Content with NO body — so an attacker probing addresses learns nothing about which
        // exist. A code is minted + "emailed" either way (accounts are created on first sight at verify
        // time), so the observable outcome is identical. Distinct addresses so the per-address cooldown
        // never fires and both calls are on the 204 (not 429) path.
        String known = "enum-known@example.com";
        String unknown = "enum-unknown@example.com";
        // Stub the Admin SDK so "known" resolves to an existing user and "unknown" is USER_NOT_FOUND —
        // the account-existence difference the endpoint must NOT leak. (Only consulted at verify time,
        // but stubbed here to make the known/unknown distinction real, not incidental.)
        UserRecord existing = org.mockito.Mockito.mock(UserRecord.class);
        when(existing.getUid()).thenReturn("uid-enum-known");
        when(firebaseAuth.getUserByEmail(known)).thenReturn(existing);
        com.google.firebase.auth.FirebaseAuthException notFound =
                org.mockito.Mockito.mock(com.google.firebase.auth.FirebaseAuthException.class);
        when(notFound.getAuthErrorCode()).thenReturn(com.google.firebase.auth.AuthErrorCode.USER_NOT_FOUND);
        when(firebaseAuth.getUserByEmail(unknown)).thenThrow(notFound);

        var knownResult = mockMvc.perform(post("/api/v1/auth/email-code/request")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + known + "\"}"))
                .andExpect(status().isNoContent())
                .andReturn();
        var unknownResult = mockMvc.perform(post("/api/v1/auth/email-code/request")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"" + unknown + "\"}"))
                .andExpect(status().isNoContent())
                .andReturn();

        // Identical outcome: same status, and an empty body in BOTH cases (no leak either way).
        assertThat(knownResult.getResponse().getStatus())
                .isEqualTo(unknownResult.getResponse().getStatus());
        assertThat(knownResult.getResponse().getContentAsString()).isEmpty();
        assertThat(unknownResult.getResponse().getContentAsString()).isEmpty();
        // A code was actually issued for BOTH addresses — proving the endpoint doesn't short-circuit
        // (which would itself be a timing/behaviour enumeration signal) for the unknown one.
        assertThat(mailer.codes.get(known)).matches("\\d{6}");
        assertThat(mailer.codes.get(unknown)).matches("\\d{6}");
    }

    @Test
    void peekEndpointIsClosedWhenEmulatorHostUnset() throws Exception {
        // TM-738 P0 (auth): the emulator-only code-peek (which hands back the plaintext login code for
        // the e2e harness) must be CLOSED in any real environment. Both its beans are gated on
        // FIREBASE_AUTH_EMULATOR_HOST being set (EmulatorEmailCodeSupport.EMULATOR_ONLY); the test
        // profile does NOT set it, so the RecordingEmailCodeMailer + EmailCodePeekController beans are
        // absent and the route has no handler. SecurityConfig still permit-lists the path (the permit is
        // inert with no handler), so the request is NOT a 401 — it is a 404, and critically it NEVER
        // returns 200 with a code. This is the security-negative: no code is ever served off-emulator.
        var result = mockMvc.perform(get("/auth/email-code/peek").param("email", "anyone@example.com"))
                .andReturn();
        assertThat(result.getResponse().getStatus())
                .as("peek must not exist off-emulator (no handler -> 404), and must never be 200")
                .isEqualTo(404);
        // Belt-and-braces: whatever the status, the body must not carry a code (never a 200 leak).
        assertThat(result.getResponse().getStatus()).isNotEqualTo(200);
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
