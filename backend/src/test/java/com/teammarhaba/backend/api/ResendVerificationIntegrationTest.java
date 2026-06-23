package com.teammarhaba.backend.api;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseToken;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.AbstractIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * {@code POST /api/v1/me/resend-verification} (TM-165) end-to-end through the real security chain and
 * the real {@link com.teammarhaba.backend.auth.EmailVerificationService}, with a mocked
 * {@link FirebaseAuth} standing in for token verification and the Admin SDK.
 *
 * <p>Covers: an unverified caller triggers a resend (204) and the Admin SDK link is generated; an
 * already-verified caller is refused (422, problem+json) with no send; the per-user cooldown turns a
 * rapid second call into a 429; and an anonymous caller is rejected with the uniform 401.
 */
@AutoConfigureMockMvc
class ResendVerificationIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private FirebaseAuth firebaseAuth;

    /**
     * Make the mocked verifier accept a per-test token for a distinct caller (uid/email derived from
     * {@code who}) and return their record. Distinct identities per test keep the cooldown — held in
     * the shared singleton service across the cached context — from coupling the tests.
     *
     * @return the bearer token value to send for this caller
     */
    private String stubCaller(String who, boolean emailVerified) throws Exception {
        String uid = "uid-" + who;
        String email = who + "@example.com";
        String tokenValue = "token-" + who;

        FirebaseToken token = mock(FirebaseToken.class);
        when(token.getUid()).thenReturn(uid);
        when(token.getEmail()).thenReturn(email);
        when(firebaseAuth.verifyIdToken(tokenValue)).thenReturn(token);

        UserRecord record = mock(UserRecord.class);
        when(record.getEmail()).thenReturn(email);
        when(record.isEmailVerified()).thenReturn(emailVerified);
        when(firebaseAuth.getUser(uid)).thenReturn(record);
        return tokenValue;
    }

    @Test
    void unverifiedCallerTriggersResendAndGets204() throws Exception {
        String token = stubCaller("unverified", false);

        mockMvc.perform(post("/api/v1/me/resend-verification").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isNoContent());

        verify(firebaseAuth).generateEmailVerificationLink("unverified@example.com");
    }

    @Test
    void alreadyVerifiedCallerIsRefusedWith422AndNoSend() throws Exception {
        String token = stubCaller("verified", true);

        mockMvc.perform(post("/api/v1/me/resend-verification").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.status").value(422));

        verify(firebaseAuth, never()).generateEmailVerificationLink(anyString());
    }

    @Test
    void rapidSecondCallHitsTheCooldownAndGets429() throws Exception {
        String token = stubCaller("burst", false);

        mockMvc.perform(post("/api/v1/me/resend-verification").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isNoContent());

        mockMvc.perform(post("/api/v1/me/resend-verification").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isTooManyRequests())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.status").value(429));
    }

    @Test
    void anonymousCallerIsRejectedWith401() throws Exception {
        mockMvc.perform(post("/api/v1/me/resend-verification")).andExpect(status().isUnauthorized());
    }
}
