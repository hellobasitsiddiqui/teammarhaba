package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseToken;
import com.google.firebase.auth.UserMetadata;
import com.google.firebase.auth.UserRecord;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.user.Role;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserAdminService;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpHeaders;
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

    /** The real admin disable/suspend path (flips {@code enabled=false} + audits) — TM-741/TM-742. */
    @Autowired
    private UserAdminService userAdmin;

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
                .andExpect(jsonPath("$.role").value("USER"))
                // admin (TM-589): a default USER is not an app-admin, so the flag is false.
                .andExpect(jsonPath("$.admin").value(false));

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
    void notificationPrefDefaultsToBothForNewAccounts() throws Exception {
        // TM-427: a brand-new account is provisioned with BOTH email and push (was EMAIL-only), so it is
        // set up to receive push the moment a device registers rather than silently missing it. The
        // migration only changes the default for new rows — existing accounts keep their preference.
        mockMvc.perform(get("/api/v1/me").with(caller("uid-default-pref", "eve@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.notificationPref").value("BOTH"))
                .andExpect(jsonPath("$.firstName").doesNotExist());
    }

    @Test
    void themePrefsDefaultToPaperTealAndSketchyOnForNewAccounts() throws Exception {
        // TM-529 AC4: a brand-new account defaults to Paper with the default accent ("teal", the
        // TM-510 --accent) and the default sketchy state (ON — the hand-drawn wobble is the app's
        // character; clean Paper is the opt-out). Provisioned from the entity defaults on first sight.
        mockMvc.perform(get("/api/v1/me").with(caller("uid-default-theme", "mila@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.themeAccent").value("teal"))
                .andExpect(jsonPath("$.themeSketchy").value(true));
    }

    @Test
    void patchThenGetRoundTripsThemePrefs() throws Exception {
        // TM-529 AC2/AC3: the chosen colour swatch + the sketchy flag persist server-side per user and
        // survive a reload (a fresh GET reads them back from the database, not from localStorage).
        var who = caller("uid-theme", "leo@example.com");

        String body = """
                { "themeAccent": "coral", "themeSketchy": false }""";

        mockMvc.perform(patch("/api/v1/me").with(who).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.themeAccent").value("coral"))
                .andExpect(jsonPath("$.themeSketchy").value(false));

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.themeAccent").value("coral"))
                .andExpect(jsonPath("$.themeSketchy").value(false));
    }

    @Test
    void rejectsUnknownThemeAccentWith400() throws Exception {
        // TM-529 AC6: the colour control is a FIXED curated palette, not a free picker — and no
        // non-Paper theme is selectable. A retired theme name (or any value outside the palette) is a
        // uniform 400 at the web boundary, so it can never reach persistence.
        var who = caller("uid-bad-accent", "nyx@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"themeAccent\":\"sketch\"}"))
                .andExpect(status().isBadRequest());
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"themeAccent\":\"#ff0000\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void patchIsPartialAndLeavesOmittedFieldsUnchanged() throws Exception {
        var who = caller("uid-partial", "grace@example.com");

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Grace\",\"city\":\"Sharjah\"}"))
                .andExpect(status().isOk());

        // A second PATCH touching only one field must not wipe the others.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"lastName\":\"Hopper\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Grace"))
                .andExpect(jsonPath("$.lastName").value("Hopper"))
                .andExpect(jsonPath("$.city").value("Sharjah"));
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
    void ageIsBoundedToEighteenToNinetyNine() throws Exception {
        // TM-884: the platform age band tightened from 13–120 to 18–99 on new saves/edits. 17 and
        // 100 (both legal under the old band) are now rejected; the new inclusive bounds save fine.
        var who = caller("uid-age-band", "band@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":17}"))
                .andExpect(status().isBadRequest());
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":100}"))
                .andExpect(status().isBadRequest());
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":18}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.age").value(18));
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":99}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.age").value(99));
    }

    @Test
    void existingUnderageAccountIsGrandfatheredOnReadAndUnrelatedEdits() throws Exception {
        // TM-884 grandfathering: an account whose stored age predates the 18–99 band is never
        // rejected on read, and a PATCH that omits age (the client omits an unchanged value) still
        // saves other fields and leaves the stored age untouched. Only a NEW age save is banded.
        var who = caller("uid-age-gf", "gf@example.com");
        mockMvc.perform(get("/api/v1/me").with(who)).andExpect(status().isOk()); // provision the row
        var saved = users.findByFirebaseUid("uid-age-gf").orElseThrow();
        saved.setAge(15); // a 13–120-era value, seeded directly (the API can no longer write it)
        users.save(saved);

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.age").value(15));
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Young\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Young"))
                .andExpect(jsonPath("$.age").value(15));
    }

    @Test
    void patchAcceptsUnchangedGrandfatheredAgeAndStillBandsNewValues() throws Exception {
        // TM-900: grandfathering must hold for ANY API client, not just the web form (which omits an
        // unchanged age from the PATCH). The band check lives in the service BEHIND the
        // Objects.equals unchanged-guard (mirroring the TM-877 city pattern), so re-sending the
        // stored out-of-band age is a no-op 200 — the rest of the form still saves — while a NEW
        // out-of-band value (even on the same account) is still a 400.
        var who = caller("uid-age-resend", "resend@example.com");
        mockMvc.perform(get("/api/v1/me").with(who)).andExpect(status().isOk()); // provision the row
        var saved = users.findByFirebaseUid("uid-age-resend").orElseThrow();
        saved.setAge(15); // a 13–120-era value, seeded directly (the API can no longer write it)
        users.save(saved);

        // Re-sending the SAME grandfathered age (a client that echoes the whole form) is a no-op 200
        // and must not block the other fields in the request.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":15,\"firstName\":\"Still\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.age").value(15))
                .andExpect(jsonPath("$.firstName").value("Still"));

        // A DIFFERENT out-of-band value is still refused — the allowance is the saved value only.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":16}"))
                .andExpect(status().isBadRequest());

        // And on a fresh account (no stored age) the same value is a NEW save → banded → 400.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-age-new15", "new15@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":15}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void cityRejectsAnOffListNewValueWith400() throws Exception {
        // TM-877: city is a dropdown of the interim allowed list — a NEW value outside it (fine
        // name-like text, so it passes the TM-771 pattern) must be refused at the service.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-bad-city", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"Bristol\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void cityAcceptsEveryAllowedListValue() throws Exception {
        var who = caller("uid-city-list", "list@example.com");
        for (String city : new String[] {"London", "Milton Keynes", "Sharjah", "Karachi"}) {
            mockMvc.perform(patch("/api/v1/me")
                            .with(who)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"city\":\"" + city + "\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.city").value(city));
        }
    }

    @Test
    void savedOffListCityIsPreservedNotOverwritten() throws Exception {
        // TM-877 must-not-break: an existing off-list city (saved before the list existed) is
        // preserved — re-sending it unchanged is accepted, and an unrelated edit leaves it intact.
        var who = caller("uid-city-dubai", "dubai@example.com");
        mockMvc.perform(get("/api/v1/me").with(who)).andExpect(status().isOk()); // provision the row
        var saved = users.findByFirebaseUid("uid-city-dubai").orElseThrow();
        // Seeded directly: since TM-898 NEITHER write path can introduce an off-list city — PATCH /me
        // (TM-877) and the onboarding gate both refuse a new one — so a pre-list value can only be
        // planted straight on the row. (Before TM-898 the gate's location field could still write it.)
        saved.setCity("Dubai");
        users.save(saved);

        // Re-sending the SAME off-list value (the client re-submits the whole form) is a no-op 200.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"Dubai\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.city").value("Dubai"));

        // An unrelated edit leaves the off-list city untouched.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Expat\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.city").value("Dubai"));

        // But a DIFFERENT off-list value is still refused — the allowance is the saved value only.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"Manchester\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void storedUntrimmedCityRoundTripsItsTrimmedResubmission() throws Exception {
        // TM-900: the client's fillCitySelect TRIMS the saved city before re-selecting it, so a
        // legacy row stored with padding (" Dubai ") comes back from a full-form save as "Dubai".
        // The service must trim BEFORE the equality/allow-list checks — otherwise the trimmed
        // re-submission reads as a NEW off-list value and every full-form save 400s.
        var who = caller("uid-city-padded", "padded@example.com");
        mockMvc.perform(get("/api/v1/me").with(who)).andExpect(status().isOk()); // provision the row
        var saved = users.findByFirebaseUid("uid-city-padded").orElseThrow();
        saved.setCity(" Dubai "); // a legacy padded value, seeded directly
        users.save(saved);

        // The trimmed echo of the stored value is an unchanged no-op 200, not a rejected new city.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"Dubai\",\"firstName\":\"Expat\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Expat"));

        // A different off-list value is still refused — trimming must not widen the allowance.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"Manchester\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void patchTrimsANewCityBeforeTheAllowListCheck() throws Exception {
        // TM-900: an allowed-list city arriving with stray padding ("  London  " passes the
        // NAME_LIKE pattern — spaces are legal name characters) must be recognised as the list value
        // and stored trimmed, not bounced as off-list.
        var who = caller("uid-city-padnew", "padnew@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"  London  \"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.city").value("London"));
        assertThat(users.findByFirebaseUid("uid-city-padnew").orElseThrow().getCity())
                .isEqualTo("London");
    }

    @Test
    void patchWithBlankPhoneSucceedsAndRoundTrips() throws Exception {
        // TM-188: a user with no phone on record saves with a blank phone — must be accepted (200),
        // not rejected by the phone pattern, and round-trip as an empty/cleared value.
        var who = caller("uid-blank-phone", "ada@example.com");

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Ada L\",\"phone\":\"\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Ada L"))
                .andExpect(jsonPath("$.phone").value(""));

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Ada L"))
                .andExpect(jsonPath("$.phone").value(""));
    }

    @Test
    void patchWithAbsentPhoneSucceeds() throws Exception {
        // TM-188: omitting phone entirely is the client's new behaviour for a blank field — still 200.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-no-phone", "grace@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Grace H\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Grace H"))
                .andExpect(jsonPath("$.phone").doesNotExist());
    }

    @Test
    void rejectsNonEmptyInvalidPhoneWith400() throws Exception {
        // TM-188: allowing "" must not relax validation for a genuinely invalid, non-empty phone.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-bad-phone", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"not-a-phone!\"}"))
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

    /**
     * GET /me always reports the currently published terms version (TM-170) from the
     * app.terms.current-version config constant, so the client can gate the app until the user's
     * accepted version matches. A fresh user has never accepted, so currentTermsVersion is present
     * while termsAcceptedVersion is absent — exactly the "needs acceptance" signal the gate keys on.
     */
    @Test
    void meExposesCurrentTermsVersionForTheGate() throws Exception {
        mockMvc.perform(get("/api/v1/me").with(caller("uid-current-terms", "grace@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentTermsVersion").value("2026-06-01"))
                .andExpect(jsonPath("$.termsAcceptedVersion").doesNotExist());
    }

    @Test
    void onboardingCompleteSetsFlagAndVerifiesAgeWhenAgeOnRecord() throws Exception {
        var who = caller("uid-onboard", "ada@example.com");

        // Age supplied first (TM-162), so completing onboarding self-attests it (TM-163). A phone
        // must also be on record before the transition is allowed (TM-880).
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"age\":36,\"phone\":\"+447700900123\"}"))
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

        // Phone on record (the TM-880 precondition) but no age: the flag flips, the age stays unverified.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+447700900124\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true))
                .andExpect(jsonPath("$.ageVerified").value(false));
    }

    @Test
    void onboardingCompleteRejectedWithoutPhoneOnRecordWith400() throws Exception {
        // TM-880: the onboarding-complete state must be unreachable without a valid E.164 phone —
        // this endpoint is the API's other route to it, so it too refuses a phone-less account.
        var who = caller("uid-onboard-nophone", "nophone@example.com");

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isBadRequest());

        // Nothing half-applied: the account is still not onboarding-complete.
        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(false));
    }

    @Test
    void onboardingCompleteRejectedWithLegacyBarePhoneOnRecordWith400() throws Exception {
        // TM-880: a pre-TM-781 bare national number on record is country-ambiguous — NOT a valid
        // E.164 phone — so the transition is refused until the user confirms it through the gate.
        var who = caller("uid-onboard-barephone", "bare@example.com");
        mockMvc.perform(get("/api/v1/me").with(who)).andExpect(status().isOk()); // provision the row
        var saved = users.findByFirebaseUid("uid-onboard-barephone").orElseThrow();
        saved.setPhone("07700 900123"); // legacy shape, seeded directly (the API no longer accepts it)
        users.save(saved);

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isBadRequest());
    }

    @Test
    void flagOffOnboardingPathsNeverTouchFirebase() throws Exception {
        // TM-931 deploy-safety: with app.phone.require-verified OFF (the default, unset in every
        // committed config), NEITHER onboarding transition makes a Firebase Admin SDK call — flag-off
        // behaviour is byte-for-byte the pre-TM-931 baseline. We drive both paths without ever hitting
        // GET /me (which DOES read Firebase state for its own reasons), then assert zero interaction.
        var whoComplete = caller("uid-flagoff-complete", "flagoff1@example.com");
        // Seed a valid stored phone via PATCH (no Firebase call), then complete onboarding.
        mockMvc.perform(patch("/api/v1/me")
                        .with(whoComplete)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+447700900321\"}"))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(whoComplete))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true));

        // The atomic gate path collects its own phone in-request.
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(caller("uid-flagoff-gate", "flagoff2@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Flag Off\",\"location\":\"London\",\"age\":30,"
                                + "\"phone\":\"+447700900654\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true))
                .andExpect(jsonPath("$.phone").value("+447700900654")); // client value kept (not overwritten)

        // The whole point: no getUser (or any) call reached the mocked Admin SDK on either path.
        org.mockito.Mockito.verifyNoInteractions(firebaseAuth);
    }

    @Test
    void patchingAPhoneAnotherAccountAlreadyHoldsIsA409AlreadyRegistered() throws Exception {
        // TM-931: the V48 normalized-phone unique index guarantees 1:1 even flag-off. Two accounts
        // that PATCH the SAME number (in different separator shapes — the index normalizes both to the
        // same key) collide: the second trips the index and surfaces as the friendly 409 copy, not 500.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-dup-first", "dup1@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+44 20 7946 0958\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-dup-second", "dup2@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+442079460958\"}")) // same number, no separators
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.detail").value("This phone number is already registered to another account"));
    }

    @Test
    void onboardingCompleteIsIdempotentWhenAlreadyComplete() throws Exception {
        // TM-171: the first-login tour calls POST /me/onboarding-complete on finish/skip to durably
        // suppress itself — possibly for a user the TM-250 profile gate already marked complete. A
        // repeat call must stay 200 and keep the flag true (no error, no flip back to false).
        var who = caller("uid-onboard-twice", "rumi@example.com");

        // A phone on record first — the TM-880 precondition for the transition.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+447700900125\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true));

        mockMvc.perform(post("/api/v1/me/onboarding-complete").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true));

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.onboardingCompleted").value(true));
    }

    @Test
    void onboardingGatePersistsNameLocationAgePhoneAndCompletesInOneShot() throws Exception {
        // TM-250 + TM-880: the first-use profile gate. One atomic POST sets name (→ displayName),
        // location (→ city), age AND the mandatory phone, flips onboardingCompleted, and
        // self-attests the age.
        var who = caller("uid-gate", "ibn@example.com");

        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Ibn Battuta\",\"location\":\"London\",\"age\":30,"
                                + "\"phone\":\"+212612345678\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Ibn Battuta"))
                .andExpect(jsonPath("$.city").value("London"))
                .andExpect(jsonPath("$.age").value(30))
                .andExpect(jsonPath("$.phone").value("+212612345678"))
                .andExpect(jsonPath("$.onboardingCompleted").value(true))
                .andExpect(jsonPath("$.ageVerified").value(true));

        // Persisted: a fresh GET reads the same values + flags back from the database.
        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Ibn Battuta"))
                .andExpect(jsonPath("$.city").value("London"))
                .andExpect(jsonPath("$.age").value(30))
                .andExpect(jsonPath("$.phone").value("+212612345678"))
                .andExpect(jsonPath("$.onboardingCompleted").value(true));

        // And on the row itself (not just echoed back in the response).
        var saved = users.findByFirebaseUid("uid-gate").orElseThrow();
        assertThat(saved.getDisplayName()).isEqualTo("Ibn Battuta");
        assertThat(saved.getCity()).isEqualTo("London");
        assertThat(saved.getAge()).isEqualTo(30);
        assertThat(saved.getPhone()).isEqualTo("+212612345678");
        assertThat(saved.isOnboardingCompleted()).isTrue();
    }

    @Test
    void onboardingGateSeedsFirstAndLastNameFromTheCapturedName() throws Exception {
        // TM-883: onboarding only ever wrote displayName, so firstName/lastName stayed null and the
        // profile identity header had nothing but fallbacks to show. The captured full name now also
        // seeds both parts (first word → firstName, remainder → lastName) and GET /me carries them.
        var who = caller("uid-gate-names", "priya@example.com");

        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Priya Sharma\",\"location\":\"London\",\"age\":28,"
                                + "\"phone\":\"+447700900001\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Priya Sharma"))
                .andExpect(jsonPath("$.firstName").value("Priya"))
                .andExpect(jsonPath("$.lastName").value("Sharma"));

        // A named account's GET /me carries the names — the identity header's actual data source.
        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Priya"))
                .andExpect(jsonPath("$.lastName").value("Sharma"));

        var saved = users.findByFirebaseUid("uid-gate-names").orElseThrow();
        assertThat(saved.getFirstName()).isEqualTo("Priya");
        assertThat(saved.getLastName()).isEqualTo("Sharma");
    }

    @Test
    void onboardingGateSeedsFirstNameOnlyForASingleWordName() throws Exception {
        // TM-883: a single-word name is all first name — no fabricated last name.
        var who = caller("uid-gate-oneword", "sting@example.com");

        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Sting\",\"location\":\"Karachi\",\"age\":45,"
                                + "\"phone\":\"+447700900002\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Sting"))
                .andExpect(jsonPath("$.lastName").doesNotExist());
    }

    @Test
    void onboardingGateSplitsOnTheFirstSpaceOnly() throws Exception {
        // TM-883: multi-word names keep everything after the first word as the last name.
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(caller("uid-gate-multiword", "mary@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Mary Jane Watson\",\"location\":\"Sharjah\",\"age\":31,"
                                + "\"phone\":\"+447700900003\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Mary"))
                .andExpect(jsonPath("$.lastName").value("Jane Watson"));
    }

    @Test
    void onboardingGateNeverOverwritesAnExplicitFirstOrLastName() throws Exception {
        // TM-883: the split is a seed for accounts with NO first/last name — a name the user set
        // explicitly (PATCH /me) is their own correction and survives an onboarding re-submit.
        var who = caller("uid-gate-keepnames", "amelia@example.com");

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Amelia Rose\",\"lastName\":\"Pond\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Amelia Williams\",\"location\":\"London\",\"age\":26,"
                                + "\"phone\":\"+447700900004\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Amelia Williams"))
                .andExpect(jsonPath("$.firstName").value("Amelia Rose"))
                .andExpect(jsonPath("$.lastName").value("Pond"));
    }

    @Test
    void onboardingGateTrimsNameAndLocation() throws Exception {
        var who = caller("uid-gate-trim", "trim@example.com");
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"  Mansa Musa  \",\"location\":\"  London  \",\"age\":40,"
                                + "\"phone\":\"+22370000000\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Mansa Musa"))
                .andExpect(jsonPath("$.city").value("London"));
    }

    @Test
    void onboardingGateRejectsNonNameLikeNameWith400AndNeverSeedsNames() throws Exception {
        // TM-898 (from the TM-892 review): the gate's name seeds displayName AND — via the TM-883
        // split — firstName/lastName, so it must carry the same TM-771 name-like rule as the
        // PATCH /me fields. Onboarding as "676767" used to persist first_name=676767, a value the
        // edit form itself then refuses to re-save. Now the boundary 400s it, so a non-name-like
        // name can never reach the TM-883 seed at all.
        var who = caller("uid-gate-numname", "num@example.com");
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"676767\",\"location\":\"London\",\"age\":30,"
                                + "\"phone\":\"+447700900005\"}"))
                .andExpect(status().isBadRequest());

        // Nothing seeded: the row (if the request even provisioned one) carries no name parts.
        users.findByFirebaseUid("uid-gate-numname").ifPresent(u -> {
            assertThat(u.getDisplayName()).isNull();
            assertThat(u.getFirstName()).isNull();
            assertThat(u.getLastName()).isNull();
            assertThat(u.isOnboardingCompleted()).isFalse();
        });
    }

    @Test
    void onboardingGateRejectsNonNameLikeLocationWith400() throws Exception {
        // TM-898: location maps onto the same city column as PATCH /me's name-like city field, so a
        // purely numeric location must be refused at the boundary too.
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(caller("uid-gate-numloc", "numloc@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Anon User\",\"location\":\"676767\",\"age\":30,"
                                + "\"phone\":\"+447700900006\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void onboardingGateRejectsAnOffListNewLocationWith400() throws Exception {
        // TM-898: the gate must enforce the TM-877 allowed-city list like PATCH /me does — a
        // name-like but off-list location ("Bristol") used to persist and bypass the dropdown.
        var who = caller("uid-gate-offlist", "offlist@example.com");
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Anon User\",\"location\":\"Bristol\",\"age\":30,"
                                + "\"phone\":\"+447700900007\"}"))
                .andExpect(status().isBadRequest());

        // Nothing half-applied: the account (if provisioned) is still un-onboarded with no city.
        users.findByFirebaseUid("uid-gate-offlist").ifPresent(u -> {
            assertThat(u.getCity()).isNull();
            assertThat(u.isOnboardingCompleted()).isFalse();
        });
    }

    @Test
    void onboardingGateAcceptsResubmittedSavedOffListCityButRejectsOtherOffListValues() throws Exception {
        // TM-898: the gate's list check carries the same saved-value allowance as
        // UserService.updateProfile (TM-877) — an account whose STORED city is off-list (saved
        // before the list existed) may pass back through the gate re-submitting that same value
        // (the gate dropdown keeps it selectable), but any OTHER off-list value is still refused.
        var who = caller("uid-gate-dubai", "gatedubai@example.com");
        mockMvc.perform(get("/api/v1/me").with(who)).andExpect(status().isOk()); // provision the row
        var saved = users.findByFirebaseUid("uid-gate-dubai").orElseThrow();
        saved.setCity("Dubai"); // seeded directly — the API can no longer introduce it
        users.save(saved);

        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Expat User\",\"location\":\"Dubai\",\"age\":30,"
                                + "\"phone\":\"+447700900008\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.city").value("Dubai"))
                .andExpect(jsonPath("$.onboardingCompleted").value(true));

        // The allowance is the saved value only — a different off-list city is still a 400.
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Expat User\",\"location\":\"Manchester\",\"age\":30,"
                                + "\"phone\":\"+447700900008\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void onboardingGateRejectsMissingNameWith400() throws Exception {
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(caller("uid-gate-noname", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"location\":\"London\",\"age\":25,\"phone\":\"+201234567890\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void onboardingGateRejectsBlankLocationWith400() throws Exception {
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(caller("uid-gate-blankloc", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Anon\",\"location\":\"   \",\"age\":25,\"phone\":\"+201234567890\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void onboardingGateRejectsMissingAgeWith400() throws Exception {
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(caller("uid-gate-noage", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Anon\",\"location\":\"London\",\"phone\":\"+201234567890\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void onboardingGateRejectsOutOfRangeAgeWith400() throws Exception {
        // 5 was always out of range; 17 became out of range when TM-884 tightened the band to 18–99.
        for (int age : new int[] {5, 17, 100}) {
            mockMvc.perform(post("/api/v1/me/onboarding")
                            .with(caller("uid-gate-badage", "x@example.com"))
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"name\":\"Anon\",\"location\":\"London\",\"age\":" + age
                                    + ",\"phone\":\"+201234567890\"}"))
                    .andExpect(status().isBadRequest());
        }
    }

    @Test
    void onboardingGateRejectsMissingPhoneWith400() throws Exception {
        // TM-880: phone is a REQUIRED gate field — the pre-TM-880 three-field body must now 400,
        // and nothing half-applies (the account stays not-onboarding-complete).
        var who = caller("uid-gate-nophone", "gatenophone@example.com");
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Anon\",\"location\":\"London\",\"age\":25}"))
                .andExpect(status().isBadRequest());

        users.findByFirebaseUid("uid-gate-nophone")
                .ifPresent(u -> assertThat(u.isOnboardingCompleted()).isFalse());
    }

    @Test
    void onboardingGateRejectsBareNonE164PhoneWith400() throws Exception {
        // TM-880: a bare national number (no +dial) is country-ambiguous and must be refused — the
        // client's country picker always composes +<dial><national>, so only a bypassing caller
        // could send this shape.
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(caller("uid-gate-barephone", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Anon\",\"location\":\"London\",\"age\":25,"
                                + "\"phone\":\"07700 900123\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void onboardingGateDoesNotPersistOnValidationFailure() throws Exception {
        // A rejected gate submission must leave NO half-applied state — the account stays un-gated-able
        // (onboarding still incomplete) rather than a partial write sneaking through.
        var who = caller("uid-gate-atomic", "atomic@example.com");
        mockMvc.perform(post("/api/v1/me/onboarding")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Half\",\"location\":\"London\",\"age\":200,\"phone\":\"+447700900123\"}"))
                .andExpect(status().isBadRequest());

        // The account may not exist yet (request rejected before provision) — if it does, it's clean.
        users.findByFirebaseUid("uid-gate-atomic").ifPresent(u -> {
            assertThat(u.isOnboardingCompleted()).isFalse();
            assertThat(u.getDisplayName()).isNull();
        });
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

    /**
     * TM-738 P0 (profile, security-negative): PATCH /me — the caller's own profile-write endpoint — must
     * be refused for a SUSPENDED account, in the very same request, through the real security chain.
     *
     * <p>The other MeController tests inject a {@link VerifiedUser} principal directly (bypassing the
     * {@code FirebaseAuthenticationFilter}), so they never exercise the {@code enabled=false} suspension
     * gate. This drives PATCH /me through the ACTUAL filter with a valid-verifying token whose account an
     * admin has just suspended: a valid Firebase token is necessary but not sufficient — the inbound
     * {@code users.enabled} gate (TM-741/TM-742) clears the context, so the entry point returns the uniform
     * RFC 7807 401 and the mutation never reaches the controller. The 401 lands before body validation, so
     * a well-formed patch body is still refused (no write, no partial update). This mirrors
     * {@code FirebaseAuthIntegrationTest.suspendedAccountIsRejectedEvenWithAValidToken} on the read side and
     * pins the same invariant on the profile WRITE seam the audit called out.
     */
    @Test
    void patchMeRefusedForSuspendedAccount() throws Exception {
        // Seed an active account, then take the real admin "disable" action (flips enabled=false + audits).
        // A distinct acting-admin uid avoids the self-disable protection (an admin can't disable itself).
        User target = users.save(new User("uid-suspended-patch", "suspended@example.com", "Target"));
        userAdmin.update(target.getId(), false, (Role) null, "admin-uid");

        // A token that still verifies cleanly (checkRevoked=true) — the account is suspended only in OUR DB,
        // not the token. Exactly the gap the inbound gate closes.
        FirebaseToken token = mock(FirebaseToken.class);
        when(token.getUid()).thenReturn("uid-suspended-patch");
        when(token.getEmail()).thenReturn("suspended@example.com");
        when(firebaseAuth.verifyIdToken("suspended-patch-token", true)).thenReturn(token);

        mockMvc.perform(patch("/api/v1/me")
                        .header(HttpHeaders.AUTHORIZATION, "Bearer suspended-patch-token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Should Not Persist\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));

        // The refused write must have left NO trace — the suspended row's display name is untouched.
        assertThat(users.findByFirebaseUid("uid-suspended-patch").orElseThrow().getDisplayName())
                .isEqualTo("Target");
    }
}
