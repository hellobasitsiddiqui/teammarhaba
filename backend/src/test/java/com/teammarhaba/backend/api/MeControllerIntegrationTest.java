package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.UserMetadata;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code /api/v1/me} (TM-107 + TM-112): an authenticated caller gets their persisted profile,
 * provisioned just-in-time on first call and reused afterwards; {@code PATCH} updates the
 * display name; an anonymous caller gets the uniform {@code 401}. The authenticated case injects
 * a {@link VerifiedUser} principal directly (token verification is exercised separately).
 */
@AutoConfigureMockMvc
class MeControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    /**
     * Stands in for the Admin SDK that backs the live, Firebase-owned account-state block on
     * {@code GET /me} (TM-164). Tests that care about the block stub {@code getUser(uid)}; tests that
     * don't leave it unstubbed, so the lookup degrades to an all-{@code null} state (the endpoint must
     * never fail just because Firebase state can't be read).
     */
    @MockBean
    private FirebaseAuth firebaseAuth;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    /** Stub the Admin SDK to return a record for {@code uid} with the given verification state. */
    private void stubFirebaseUser(String uid, boolean emailVerified) throws Exception {
        UserMetadata metadata = mock(UserMetadata.class);
        lenient().when(metadata.getLastSignInTimestamp()).thenReturn(0L);

        UserRecord record = mock(UserRecord.class);
        lenient().when(record.isEmailVerified()).thenReturn(emailVerified);
        lenient().when(record.getPhoneNumber()).thenReturn(null);
        lenient().when(record.getPhotoUrl()).thenReturn(null);
        lenient().when(record.getProviderData()).thenReturn(null);
        lenient().when(record.getUserMetadata()).thenReturn(metadata);

        when(firebaseAuth.getUser(uid)).thenReturn(record);
    }

    @Test
    void provisionsOnFirstCallThenReuses() throws Exception {
        mockMvc.perform(get("/api/v1/me").with(caller("uid-new", "ada@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.uid").value("uid-new"))
                .andExpect(jsonPath("$.email").value("ada@example.com"))
                .andExpect(jsonPath("$.displayName").doesNotExist())
                .andExpect(jsonPath("$.role").value("USER"));

        Long firstId = users.findByFirebaseUid("uid-new").orElseThrow().getId();

        // Second call reuses the same row — no duplicate provisioning.
        mockMvc.perform(get("/api/v1/me").with(caller("uid-new", "ada@example.com"))).andExpect(status().isOk());

        assertThat(users.findByFirebaseUid("uid-new").orElseThrow().getId()).isEqualTo(firstId);
        assertThat(users.findAll().stream().filter(u -> u.getFirebaseUid().equals("uid-new")).count())
                .isEqualTo(1);
    }

    @Test
    void patchUpdatesDisplayName() throws Exception {
        var who = caller("uid-patch", "grace@example.com");

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Grace H\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Grace H"));

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Grace H"));
    }

    @Test
    void patchThenGetRoundTripsEveryProfileField() throws Exception {
        var who = caller("uid-profile", "ada@example.com");

        String body =
                """
                {
                  "displayName": "Ada L",
                  "firstName": "Ada",
                  "lastName": "Lovelace",
                  "city": "London",
                  "age": 36,
                  "phone": "+44 20 7946 0958",
                  "notificationPref": "BOTH",
                  "timezone": "Europe/London",
                  "locale": "en-GB"
                }""";

        // PATCH echoes the persisted profile back.
        mockMvc.perform(patch("/api/v1/me").with(who).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Ada L"))
                .andExpect(jsonPath("$.firstName").value("Ada"))
                .andExpect(jsonPath("$.lastName").value("Lovelace"))
                .andExpect(jsonPath("$.city").value("London"))
                .andExpect(jsonPath("$.age").value(36))
                .andExpect(jsonPath("$.phone").value("+44 20 7946 0958"))
                .andExpect(jsonPath("$.notificationPref").value("BOTH"))
                .andExpect(jsonPath("$.timezone").value("Europe/London"))
                .andExpect(jsonPath("$.locale").value("en-GB"));

        // GET reads the same values back from the database.
        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.uid").value("uid-profile"))
                .andExpect(jsonPath("$.email").value("ada@example.com"))
                .andExpect(jsonPath("$.displayName").value("Ada L"))
                .andExpect(jsonPath("$.firstName").value("Ada"))
                .andExpect(jsonPath("$.lastName").value("Lovelace"))
                .andExpect(jsonPath("$.city").value("London"))
                .andExpect(jsonPath("$.age").value(36))
                .andExpect(jsonPath("$.phone").value("+44 20 7946 0958"))
                .andExpect(jsonPath("$.notificationPref").value("BOTH"))
                .andExpect(jsonPath("$.timezone").value("Europe/London"))
                .andExpect(jsonPath("$.locale").value("en-GB"));
    }

    @Test
    void notificationPrefDefaultsToEmailUntilSet() throws Exception {
        mockMvc.perform(get("/api/v1/me").with(caller("uid-default-pref", "eve@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.notificationPref").value("EMAIL"))
                .andExpect(jsonPath("$.firstName").doesNotExist());
    }

    @Test
    void patchIsPartialAndLeavesOmittedFieldsUnchanged() throws Exception {
        var who = caller("uid-partial", "grace@example.com");

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Grace\",\"city\":\"Baltimore\"}"))
                .andExpect(status().isOk());

        // A second PATCH touching only one field must not wipe the others.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"lastName\":\"Hopper\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Grace"))
                .andExpect(jsonPath("$.lastName").value("Hopper"))
                .andExpect(jsonPath("$.city").value("Baltimore"));
    }

    @Test
    void rejectsOutOfRangeAgeWith400() throws Exception {
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-bad-age", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":5}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsUnknownTimezoneWith400() throws Exception {
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-bad-tz", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"timezone\":\"Mars/Olympus_Mons\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsUnknownNotificationPrefWith400() throws Exception {
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-bad-pref", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"notificationPref\":\"SMS\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void lifecycleFlagsDefaultToUnsetOnFreshAccount() throws Exception {
        mockMvc.perform(get("/api/v1/me").with(caller("uid-lc-default", "ada@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(false))
                .andExpect(jsonPath("$.ageVerified").value(false))
                .andExpect(jsonPath("$.termsAcceptedVersion").doesNotExist())
                .andExpect(jsonPath("$.termsAcceptedAt").doesNotExist());
    }

    @Test
    void onboardingCompleteSetsFlagAndVerifiesAgeWhenAgeOnRecord() throws Exception {
        var who = caller("uid-onboard", "ada@example.com");

        // Age supplied first (TM-162), so completing onboarding self-attests it (TM-163).
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":36}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true))
                .andExpect(jsonPath("$.ageVerified").value(true));

        // Persisted: the flags survive on a subsequent GET.
        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true))
                .andExpect(jsonPath("$.ageVerified").value(true));
    }

    @Test
    void onboardingCompleteLeavesAgeUnverifiedWhenNoAgeOnRecord() throws Exception {
        var who = caller("uid-onboard-noage", "eve@example.com");

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true))
                .andExpect(jsonPath("$.ageVerified").value(false));
    }

    @Test
    void acceptTermsRecordsVersionAndTimestampVisibleOnMe() throws Exception {
        var who = caller("uid-terms", "grace@example.com");

        mockMvc.perform(post("/api/v1/me/accept-terms")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"version\":\"2026-06-01\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.termsAcceptedVersion").value("2026-06-01"))
                .andExpect(jsonPath("$.termsAcceptedAt").exists());

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.termsAcceptedVersion").value("2026-06-01"))
                .andExpect(jsonPath("$.termsAcceptedAt").exists());
    }

    @Test
    void acceptTermsOverwritesOnReAcceptanceOfNewVersion() throws Exception {
        var who = caller("uid-terms-reaccept", "grace@example.com");

        mockMvc.perform(post("/api/v1/me/accept-terms")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"version\":\"2026-01-01\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/me/accept-terms")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"version\":\"2026-06-01\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.termsAcceptedVersion").value("2026-06-01"));
    }

    @Test
    void acceptTermsRejectsBlankVersionWith400() throws Exception {
        mockMvc.perform(post("/api/v1/me/accept-terms")
                        .with(caller("uid-terms-blank", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"version\":\"\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void verifiedUserSeesEmailVerifiedTrueFromFirebase() throws Exception {
        stubFirebaseUser("uid-verified", true);

        mockMvc.perform(get("/api/v1/me").with(caller("uid-verified", "ada@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.accountState.emailVerified").value(true));
    }

    @Test
    void unverifiedUserSeesEmailVerifiedFalseFromFirebase() throws Exception {
        stubFirebaseUser("uid-unverified", false);

        mockMvc.perform(get("/api/v1/me").with(caller("uid-unverified", "eve@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.accountState.emailVerified").value(false));
    }

    @Test
    void accountStateDegradesToNullsWhenFirebaseStateCannotBeRead() throws Exception {
        // No stub for this uid: the Admin SDK lookup can't resolve the user, so the block must
        // degrade to nulls rather than failing the caller's own /me.
        mockMvc.perform(get("/api/v1/me").with(caller("uid-no-fb", "x@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.accountState").exists())
                .andExpect(jsonPath("$.accountState.emailVerified").doesNotExist());
    }

    @Test
    void lastActiveAtIsStampedAndAdvancesAcrossTwoCalls() throws Exception {
        var who = caller("uid-last-active", "ada@example.com");
        stubFirebaseUser("uid-last-active", true);

        String firstBody = mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.lastActiveAt").exists())
                .andReturn()
                .getResponse()
                .getContentAsString();
        Instant firstActive =
                Instant.parse(com.jayway.jsonpath.JsonPath.read(firstBody, "$.lastActiveAt"));

        // A second authenticated read must advance the stamp (cheap update on every /me).
        String secondBody = mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        Instant secondActive =
                Instant.parse(com.jayway.jsonpath.JsonPath.read(secondBody, "$.lastActiveAt"));

        assertThat(secondActive).isAfterOrEqualTo(firstActive);
        // And it is genuinely persisted on our row, not just echoed.
        assertThat(users.findByFirebaseUid("uid-last-active").orElseThrow().getLastActiveAt())
                .isNotNull();
    }

    @Test
    void rejectsAnonymousWith401() throws Exception {
        mockMvc.perform(get("/api/v1/me")).andExpect(status().isUnauthorized());
    }
}
