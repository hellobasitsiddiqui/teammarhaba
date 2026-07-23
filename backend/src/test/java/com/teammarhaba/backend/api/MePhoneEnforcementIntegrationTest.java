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
        // TM-982: a phone-changing PATCH now ALSO enforces (the profile phone-edit twin), so we can no
        // longer seed a stored phone via an unenforced PATCH here — and we don't need to: the
        // onboarding-complete transition refuses purely on the absence of a Firebase-VERIFIED number
        // (enforceVerifiedPhoneIfRequired runs before requirePhoneOnRecord), whether or not a client
        // phone is on record. Provision the account with a no-op PATCH, then assert the refusal.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"timezone\":\"Europe/London\"}"))
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
                                + "\"phone\":\"+447700901302\"}")) // TM-934: unique per test (V48 index)
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
        // TM-982: a phone-changing PATCH now enforces too, so seed the account with a non-phone PATCH
        // (a phone PATCH here would itself fail closed on the stubbed Firebase error). The
        // onboarding-complete transition below is what this test exercises — it fails closed on the
        // Firebase read error regardless of any stored phone.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"timezone\":\"Europe/London\"}"))
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
                                + "\"phone\":\"+447700901304\"}")) // TM-934: unique per test (V48 index)
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value(
                        "Phone number must be verified before completing onboarding"));
    }

    // ==== TM-982: PATCH /me phone-edit enforcement — phone is a VERIFIED IDENTITY ===================
    //
    // The client's TM-982 save-block has a server twin behind the SAME flag (gated on TM-986 flipping it
    // in prod): a PATCH /me that CHANGES the phone must land on the Firebase-verified number, else the
    // write is refused/corrected. These are fail-before/pass-after: on clean main (no enforcement call in
    // updateProfile) the first would return 200 with the unverified number stored, and the second would
    // keep the client value — both flip with the TM-982 change. The flag-OFF baseline (a plain phone
    // PATCH succeeds untouched) stays covered by MeControllerIntegrationTest.

    // ---- A changed phone with NO verified number on Firebase → refused (fail-before was 200) ---------

    @Test
    void patchMeRefusesAChangedPhoneWhenNoVerifiedPhone() throws Exception {
        var who = caller("uid-enf-patch-null", "g@example.com");
        stubVerifiedPhone("uid-enf-patch-null", null);

        // Changing the phone via PATCH is refused when Firebase reports no verified number for the caller.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+447700901305\"}")) // TM-934: unique per test (V48 index)
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value(
                        "Phone number must be verified before completing onboarding"));

        // Nothing stored — the whole @Transactional PATCH rolled back (no half-applied unverified phone).
        assertThat(users.findByFirebaseUid("uid-enf-patch-null"))
                .hasValueSatisfying(u -> assertThat(u.getPhone()).isNull());
    }

    // ---- A changed phone is MIRRORED to the verified value (client value can't win) -----------------

    @Test
    void patchMeMirrorsTheVerifiedPhoneOverAChangedClientValue() throws Exception {
        var who = caller("uid-enf-patch-ok", "h@example.com");
        stubVerifiedPhone("uid-enf-patch-ok", "+447700900777");

        // Client tries to PATCH a DIFFERENT number; the Firebase-verified one must win + be what's stored.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+441111111112\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phone").value("+447700900777"));

        assertThat(users.findByFirebaseUid("uid-enf-patch-ok").orElseThrow().getPhone())
                .isEqualTo("+447700900777");
    }

    // ---- A PATCH that does NOT touch the phone never reads Firebase → succeeds untouched -------------

    @Test
    void patchMeWithoutAPhoneChangeNeverConsultsFirebase() throws Exception {
        var who = caller("uid-enf-patch-nophone", "i@example.com");
        // Deliberately DO NOT stub getUser: if enforcement were (wrongly) triggered by a non-phone PATCH,
        // the unstubbed Admin SDK call would fail closed and 400. A green 200 proves the phone-changed
        // gate keeps Firebase out of an unrelated edit (age only).
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":41}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.age").value(41));
    }

    // ==== TM-1017: a FORMAT-ONLY phone difference is NOT a change (canonical E.164) =================
    //
    // The phone-changed check in applyProfileFields compared the raw stored string against the raw
    // incoming one (Objects.equals). A legacy-formatted stored number ("+44 7700 900123") vs the
    // client's composed one ("+447700900123") is the SAME number stored two ways (V48 normalises both
    // to the digits-only key), but raw-equals reads it as a CHANGE — so with the flag ON,
    // enforceVerifiedPhoneIfRequired fired and 400'd EVERY save (even a city-only PATCH that also
    // re-sends the phone) for the unverified legacy cohort during the grace window. These are
    // fail-before/pass-after: on clean main the raw-equals sees a change → enforcement → 400; with the
    // TM-1017 canonical-equals it's a no-op → 200. getUser is deliberately UNSTUBBED, so if enforcement
    // were (wrongly) triggered the fail-closed Admin SDK read would 400 — a green 200 proves the phone
    // is treated unchanged and Firebase is never consulted.

    /** Seed {@code uid}'s account with a legacy-formatted stored phone, without tripping enforcement. */
    private void seedLegacyFormattedPhone(RequestPostProcessor who, String uid, String legacyPhone)
            throws Exception {
        // Provision via a no-op, non-phone PATCH (no phone field → no Firebase read under the flag).
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"timezone\":\"Europe/London\"}"))
                .andExpect(status().isOk());
        // Write the legacy spelling directly (a PATCH couldn't, under the flag), simulating a row saved
        // before TM-781's stricter composition — separators the client's composed value drops.
        var user = users.findByFirebaseUid(uid).orElseThrow();
        user.setPhone(legacyPhone);
        users.saveAndFlush(user);
    }

    @Test
    void patchMeCityOnlyIsNotBlockedWhenPhoneReSentInAdifferentFormat() throws Exception {
        var who = caller("uid-enf-legacy-fmt", "j@example.com");
        seedLegacyFormattedPhone(who, "uid-enf-legacy-fmt", "+44 7700 900123");

        // The web client re-sends the composed (separator-free) phone alongside a city edit. Same
        // number, different spelling → must be a NO-OP on the phone, so no enforcement, so a plain 200.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"London\",\"phone\":\"+447700900123\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.city").value("London"));

        // The stored phone is untouched (the legacy spelling stays; no mirror ran because no change).
        assertThat(users.findByFirebaseUid("uid-enf-legacy-fmt").orElseThrow().getPhone())
                .isEqualTo("+44 7700 900123");
    }

    @Test
    void patchMeReSendingTheSameNumberReformattedIsANoOp() throws Exception {
        var who = caller("uid-enf-reformat", "k@example.com");
        seedLegacyFormattedPhone(who, "uid-enf-reformat", "+44 7700 900456");

        // A PATCH carrying ONLY the phone, reformatted to the canonical spelling → unchanged number →
        // no enforcement → 200 (fail-before: raw-equals saw a change → enforcement → 400).
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+447700900456\"}"))
                .andExpect(status().isOk());

        assertThat(users.findByFirebaseUid("uid-enf-reformat").orElseThrow().getPhone())
                .isEqualTo("+44 7700 900456");
    }
}
