package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseAuthException;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * TM-931 (subticket B of TM-923): server-side verified-phone ENFORCEMENT, exercised with the flag ON
 * ({@code app.phone.require-verified=true} via {@link TestPropertySource} — never in a committed
 * config). The flag-OFF baseline lives in {@code MeControllerIntegrationTest}; a separate context is
 * used here because the flag is a context-wide property.
 *
 * <p>Every test stubs the Admin SDK's {@code getUser(uid)} → a {@link UserRecord} whose
 * {@code getPhoneNumber()} models what Firebase reports (Firebase only stores VERIFIED numbers). The
 * backend trusts only that value, never the client's. These are the fail-before/pass-after tests: on
 * clean {@code main} (no enforcement) the refusals return 200 and the mirror never overwrites — every
 * assertion below flips with the TM-931 change.
 */
@AutoConfigureMockMvc
@TestPropertySource(properties = "app.phone.require-verified=true")
class MePhoneEnforcementIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @MockBean
    private FirebaseAuth firebaseAuth;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    /** Stub the Admin SDK to report {@code phoneNumber} (null = no verified phone) for {@code uid}. */
    private void stubVerifiedPhone(String uid, String phoneNumber) throws Exception {
        UserRecord record = mock(UserRecord.class);
        when(record.getPhoneNumber()).thenReturn(phoneNumber);
        when(firebaseAuth.getUser(uid)).thenReturn(record);
    }

    /** Stub the Admin SDK to fail for {@code uid} (identity-provider error → fail closed). */
    private void stubFirebaseError(String uid) throws Exception {
        when(firebaseAuth.getUser(uid)).thenThrow(mock(FirebaseAuthException.class));
    }

    // ---- AC1: flag-on refusal when Firebase reports no verified phone ------------------------------

    @Test
    void onboardingCompleteRefusedWhenNoVerifiedPhone() throws Exception {
        var who = caller("uid-enf-complete-null", "a@example.com");
        stubVerifiedPhone("uid-enf-complete-null", null);
        // A stored (client) phone is present so the TM-880 rule alone would PASS — enforcement is what
        // refuses, keyed on the absence of a Firebase-VERIFIED number.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+447700900123\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value(
                        "Phone number must be verified before completing onboarding"));

        assertThat(users.findByFirebaseUid("uid-enf-complete-null").orElseThrow().isOnboardingCompleted())
                .isFalse();
    }

    @Test
    void onboardingGateRefusedWhenNoVerifiedPhone() throws Exception {
        var who = caller("uid-enf-gate-null", "b@example.com");
        stubVerifiedPhone("uid-enf-gate-null", null);

        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Bee Bee\",\"location\":\"London\",\"age\":30,"
                                + "\"phone\":\"+447700900123\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value(
                        "Phone number must be verified before completing onboarding"));

        // Nothing half-applied — the whole atomic gate rolled back.
        assertThat(users.findByFirebaseUid("uid-enf-gate-null"))
                .hasValueSatisfying(u -> assertThat(u.isOnboardingCompleted()).isFalse());
    }

    // ---- AC2: flag-on success + the verified number wins over the client value --------------------

    @Test
    void onboardingCompleteSucceedsAndMirrorsVerifiedPhoneOverClientValue() throws Exception {
        var who = caller("uid-enf-complete-ok", "c@example.com");
        stubVerifiedPhone("uid-enf-complete-ok", "+447700900999");
        // Client stored a DIFFERENT phone; the verified one must overwrite it.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":36,\"phone\":\"+441111111111\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true))
                .andExpect(jsonPath("$.phone").value("+447700900999"));

        assertThat(users.findByFirebaseUid("uid-enf-complete-ok").orElseThrow().getPhone())
                .isEqualTo("+447700900999");
    }

    @Test
    void onboardingGateSucceedsAndMirrorsVerifiedPhoneOverClientValue() throws Exception {
        var who = caller("uid-enf-gate-ok", "d@example.com");
        stubVerifiedPhone("uid-enf-gate-ok", "+447700900888");

        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Dee Dee\",\"location\":\"London\",\"age\":30,"
                                + "\"phone\":\"+441111111111\"}")) // different client value
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true))
                .andExpect(jsonPath("$.phone").value("+447700900888"));

        assertThat(users.findByFirebaseUid("uid-enf-gate-ok").orElseThrow().getPhone())
                .isEqualTo("+447700900888");
    }

    // ---- AC3: flag-on fail-closed when Firebase can't be read -------------------------------------

    @Test
    void onboardingCompleteFailsClosedOnFirebaseError() throws Exception {
        var who = caller("uid-enf-complete-err", "e@example.com");
        stubFirebaseError("uid-enf-complete-err");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+447700900123\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value(
                        "Phone number must be verified before completing onboarding"));

        assertThat(users.findByFirebaseUid("uid-enf-complete-err").orElseThrow().isOnboardingCompleted())
                .isFalse();
    }

    @Test
    void onboardingGateFailsClosedOnFirebaseError() throws Exception {
        var who = caller("uid-enf-gate-err", "f@example.com");
        stubFirebaseError("uid-enf-gate-err");

        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Eff Eff\",\"location\":\"London\",\"age\":30,"
                                + "\"phone\":\"+447700900123\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value(
                        "Phone number must be verified before completing onboarding"));
    }
}
