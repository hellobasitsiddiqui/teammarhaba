package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
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
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * TM-738 P1 (profile): {@code PATCH /api/v1/me} validation characterization at the web boundary, the
 * companion to {@link MeControllerIntegrationTest}. These pin EXISTING behaviour the audit called out
 * as untested through the real controller + bean-validation + service chain:
 *
 * <ul>
 *   <li>{@code patchMeRejectsOverSizeTextFields} — a value longer than the field's {@code @Size} cap
 *       (UpdateMeRequest) is a uniform {@code 400} before it can reach persistence.</li>
 *   <li>{@code patchMeRejectsInvalidLocale} — a {@code @Size}-legal but semantically unresolvable BCP-47
 *       tag is rejected {@code 400} by {@code UserService.validLocale} (Java's lenient parser accepts a
 *       garbage tag, so the service additionally requires a non-empty language).</li>
 *   <li>{@code patchCannotClearPreviouslySetPhone} — the partial-PATCH contract, exercised for phone:
 *       omitting {@code phone} from the body leaves a previously-set phone unchanged (the client's
 *       {@code collectPatch} omits a blank phone rather than sending {@code ""}, so a set phone survives
 *       an untouched field — the integration half of the collectPatch web-unit test).</li>
 * </ul>
 *
 * <p>TM-781 adds the E.164 contract tests: the profile phone is now composed client-side as
 * {@code +<dial><national>} by the mandatory country picker, so the API must refuse any bare
 * national number (no leading {@code +}) with {@code 400} — otherwise a legacy-style value could
 * sneak back into storage and defeat the picker's round-trip split. The positive cases pin that
 * proper E.164 (with or without the long-accepted separator characters between digits) still
 * round-trips and persists, and that {@code ""} still clears (the TM-188 behaviour).
 *
 * <p>The authenticated case injects a {@link VerifiedUser} principal directly (token verification is
 * exercised separately); {@link FirebaseAuth} is mocked so the Admin-SDK-backed account-state block on
 * {@code GET /me} degrades to nulls rather than the endpoint failing.
 */
@AutoConfigureMockMvc
class MeProfilePatchValidationIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @MockBean
    private FirebaseAuth firebaseAuth;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    @Test
    void patchMeRejectsOverSizeFirstNameWith400() throws Exception {
        // firstName is @Size(max = 255); 256 chars is one over the cap → uniform 400 at the boundary.
        String tooLong = "a".repeat(256);
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-oversize-first", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"" + tooLong + "\"}"))
                .andExpect(status().isBadRequest());

        // The rejected write left no row-level trace (request refused before/at validation).
        users.findByFirebaseUid("uid-oversize-first")
                .ifPresent(u -> assertThat(u.getFirstName()).isNull());
    }

    @Test
    void patchMeRejectsOverSizeCityWith400() throws Exception {
        // city is @Size(max = 255) too — a second field to pin the @Size gate isn't first-name-specific.
        String tooLong = "c".repeat(256);
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-oversize-city", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"" + tooLong + "\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void patchMeAcceptsTextFieldExactlyAtTheSizeCap() throws Exception {
        // Boundary companion: a firstName at EXACTLY the 255-char cap is @Size-legal → 200, so the gate
        // rejects only genuinely over-long input (an off-by-one to < would wrongly reject this).
        String atCap = "a".repeat(255);
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-atcap-first", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"" + atCap + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value(atCap));
    }

    @Test
    void patchMeRejectsInvalidLocaleWith400() throws Exception {
        // "12345" is @Size(max = 35)-legal but Locale.forLanguageTag yields an EMPTY language, so
        // UserService.validLocale throws BadRequestException → 400. A garbage tag can never persist.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-bad-locale", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"locale\":\"12345\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void patchMeAcceptsAValidBcp47Locale() throws Exception {
        // The negative above must not be a blanket reject: a real BCP-47 tag round-trips (200 + persisted).
        var who = caller("uid-good-locale", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"locale\":\"en-GB\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.locale").value("en-GB"));
    }

    @Test
    void patchOmittingPhoneLeavesAPreviouslySetPhoneUnchanged() throws Exception {
        // patchCannotClearPreviouslySetPhone (integration half): the client's collectPatch OMITS a blank
        // phone rather than sending "", so a PATCH that doesn't include phone must leave the stored phone
        // exactly as it was — the partial-PATCH contract applied to phone specifically.
        var who = caller("uid-keep-phone", "x@example.com");

        // Establish a phone on the record. TM-934: a number unique to THIS test method — the
        // users_phone_normalized_uq index (V48) makes every persisted phone in the shared
        // Testcontainers DB unique, so tests can no longer reuse one literal across methods.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+44 20 7946 1001\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phone").value("+44 20 7946 1001"));

        // A later PATCH that OMITS phone (edits only the display name) must not wipe it.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Ada L\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Ada L"))
                .andExpect(jsonPath("$.phone").value("+44 20 7946 1001"));

        // And it is genuinely still on the row, not just echoed.
        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phone").value("+44 20 7946 1001"));
        assertThat(users.findByFirebaseUid("uid-keep-phone").orElseThrow().getPhone())
                .isEqualTo("+44 20 7946 1001");
    }

    @Test
    void patchMeRejectsPurelyNumericNameAndCityWith400() throws Exception {
        // TM-771: firstName/lastName/city carried only @Size, so a purely numeric value ("676767")
        // persisted as a name or city. The name-like @Pattern (at least one letter; letters, spaces,
        // hyphens, apostrophes and periods only) must reject it at the bean-validation boundary.
        for (String fieldName : List.of("firstName", "lastName", "city")) {
            mockMvc.perform(patch("/api/v1/me")
                            .with(caller("uid-numeric-" + fieldName, "x@example.com"))
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"" + fieldName + "\":\"676767\"}"))
                    .andExpect(status().isBadRequest());
        }

        // The rejected write left no row-level trace.
        users.findByFirebaseUid("uid-numeric-firstName")
                .ifPresent(u -> assertThat(u.getFirstName()).isNull());
    }

    @Test
    void patchMeAcceptsRealNamesIncludingPunctuationAndNonAscii() throws Exception {
        // The TM-771 negative must not over-reject: hyphens, apostrophes, periods, spaces and
        // non-ASCII letters are all legitimate name characters and must round-trip. (City left out
        // here since TM-877: it is now allowed-list constrained — "Milton Keynes" pins the
        // list-value-with-a-space case instead of the old free-text "São Paulo".)
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-real-name", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Jean-Luc\",\"lastName\":\"O'Brien\",\"city\":\"Milton Keynes\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Jean-Luc"))
                .andExpect(jsonPath("$.lastName").value("O'Brien"))
                .andExpect(jsonPath("$.city").value("Milton Keynes"));
    }

    // ------------------------------------------------------------------
    // TM-781 — mandatory country picker: the API side of the contract.
    // The web form always composes +<dial><national>, so a value WITHOUT a
    // leading + can only come from a stale/bypassing client and must be 400.
    // ------------------------------------------------------------------

    @Test
    void patchMeRejectsBareNationalPhoneWithSeparatorsWith400() throws Exception {
        // "020 7946 0958" is a perfectly plausible UK number as a human would type it — which is
        // exactly why it must be refused: without the +dial prefix the country is ambiguous and the
        // picker's E.164 round-trip split would misparse it on the next form open.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-bare-phone-sep", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"020 7946 0958\"}"))
                .andExpect(status().isBadRequest());

        // The rejected value never reached the row (bean validation fires before the service).
        users.findByFirebaseUid("uid-bare-phone-sep")
                .ifPresent(u -> assertThat(u.getPhone()).isNull());
    }

    @Test
    void patchMeRejectsBareNationalPhoneDigitsOnlyWith400() throws Exception {
        // Digits-only variant: 10 digits is length-plausible, so this proves the reject is about
        // the missing leading +, not about length or separator characters.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-bare-phone-digits", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"7700900123\"}"))
                .andExpect(status().isBadRequest());

        users.findByFirebaseUid("uid-bare-phone-digits")
                .ifPresent(u -> assertThat(u.getPhone()).isNull());
    }

    @Test
    void patchMeAcceptsCompactE164PhoneAndPersistsIt() throws Exception {
        // The canonical value the picker composes: +dial immediately followed by the national
        // digits, no separators. 12 digits sits comfortably inside the 7–15 digit guard (TM-752).
        var who = caller("uid-e164-compact", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+447700900123\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phone").value("+447700900123"));

        // Round-trip: genuinely on the row, not just echoed back by the PATCH response.
        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phone").value("+447700900123"));
        assertThat(users.findByFirebaseUid("uid-e164-compact").orElseThrow().getPhone())
                .isEqualTo("+447700900123");
    }

    @Test
    void patchMeAcceptsE164PhoneWithSeparatorsAndPersistsIt() throws Exception {
        // Tightening to require the leading + must NOT drop the long-standing leniency about
        // separator characters BETWEEN digits — human-formatted E.164 still round-trips verbatim.
        var who = caller("uid-e164-spaced", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+44 20 7946 0958\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phone").value("+44 20 7946 0958"));

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phone").value("+44 20 7946 0958"));
        assertThat(users.findByFirebaseUid("uid-e164-spaced").orElseThrow().getPhone())
                .isEqualTo("+44 20 7946 0958");
    }

    @Test
    void patchMeStillAcceptsEmptyPhoneToClear() throws Exception {
        // The ^$| empty-string alternative survives the tightening (TM-188): a blank national
        // number stays blank — the client never composes a dial-code-only value, it sends "".
        var who = caller("uid-clear-phone", "x@example.com");

        // Set a valid phone first so the clear is observable as a real transition, not a no-op.
        // TM-934: a number unique to this test (the V48 unique index bans reusing one literal across
        // methods in the shared Testcontainers DB); the value is irrelevant — it's cleared next.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"+447700901103\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.phone").value(""));

        assertThat(users.findByFirebaseUid("uid-clear-phone").orElseThrow().getPhone())
                .isEqualTo("");
    }

    // ------------------------------------------------------------------
    // TM-1134 — nationality (ISO-3166 alpha-2 code): the PATCH /me + GET /me
    // contract, mirroring the city allow-list + gender partial-PATCH rules.
    // ------------------------------------------------------------------

    @Test
    void patchMeAcceptsAKnownNationalityCodeAndMeResponseCarriesIt() throws Exception {
        // A recognised alpha-2 code round-trips through PATCH, is echoed on the mutation response, is
        // genuinely persisted on the row, and — the key contract — MeResponse carries `nationality` on
        // a fresh GET /me read (not just the write echo).
        var who = caller("uid-nat-ok", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nationality\":\"GB\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nationality").value("GB"));

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nationality").value("GB"));
        assertThat(users.findByFirebaseUid("uid-nat-ok").orElseThrow().getNationality())
                .isEqualTo("GB");
    }

    @Test
    void patchMeUpperCasesALowerCaseNationalityCode() throws Exception {
        // The stored/echoed value is canonical upper-case so a lower-case "ae" reads as "AE" — this
        // keeps the client's next-save unchanged-guard comparison stable (a stored "AE" vs a re-sent
        // "AE"), and matches the frontend option values (upper-case iso2).
        var who = caller("uid-nat-lower", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nationality\":\"ae\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nationality").value("AE"));
        assertThat(users.findByFirebaseUid("uid-nat-lower").orElseThrow().getNationality())
                .isEqualTo("AE");
    }

    @Test
    void patchMeRejectsAnUnknownNationalityCodeWith400() throws Exception {
        // "ZZ" is a well-formed two-letter shape (passes the boundary @Pattern) but is NOT a known
        // country code, so the service rejects it with a 400 — the "unknown code" branch, mirroring
        // the city allow-list check. The rejected write leaves no nationality on the row.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-nat-unknown", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nationality\":\"ZZ\"}"))
                .andExpect(status().isBadRequest());

        users.findByFirebaseUid("uid-nat-unknown")
                .ifPresent(u -> assertThat(u.getNationality()).isNull());
    }

    @Test
    void patchMeRejectsAMalformedNationalityShapeWith400() throws Exception {
        // A value that isn't blank-or-two-letters (e.g. three letters) is refused by the boundary
        // @Pattern before it even reaches the service — a uniform 400.
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-nat-malformed", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nationality\":\"GBR\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void patchMeAcceptsABlankNationalityWhichClearsToNull() throws Exception {
        // Blank is allowed (the optional-field contract). Set a code, then send "" to clear it: the
        // stored value goes back to null (the "unknown" state), not the empty string — so it reads
        // exactly like a legacy never-chose row.
        var who = caller("uid-nat-clear", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nationality\":\"FR\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nationality").value("FR"));

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nationality\":\"\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nationality").doesNotExist());

        assertThat(users.findByFirebaseUid("uid-nat-clear").orElseThrow().getNationality())
                .isNull();
    }

    @Test
    void patchOmittingNationalityLeavesAPreviouslySetOneUnchanged() throws Exception {
        // Partial-PATCH (like gender/city): a PATCH that omits nationality must leave a set value alone.
        var who = caller("uid-nat-keep", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nationality\":\"PK\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nationality").value("PK"));

        // Edit only the display name — nationality must survive untouched.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Sara\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nationality").value("PK"));
        assertThat(users.findByFirebaseUid("uid-nat-keep").orElseThrow().getNationality())
                .isEqualTo("PK");
    }

    // ------------------------------------------------------------------
    // TM-1139 — bio (short free-text intro): the PATCH /me + GET /me
    // contract, mirroring the nationality/city partial-PATCH clear rules
    // (but free text — only a 160-char length cap, no known-value check).
    // ------------------------------------------------------------------

    @Test
    void patchMeAcceptsABioAndMeResponseCarriesIt() throws Exception {
        // A bio round-trips through PATCH, is echoed on the mutation response, is persisted on the row,
        // and — the key contract — MeResponse carries `bio` on a fresh GET /me read (not just the echo).
        var who = caller("uid-bio-ok", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"bio\":\"Coffee, code and long walks.\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bio").value("Coffee, code and long walks."));

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bio").value("Coffee, code and long walks."));
        assertThat(users.findByFirebaseUid("uid-bio-ok").orElseThrow().getBio())
                .isEqualTo("Coffee, code and long walks.");
    }

    @Test
    void patchMeAcceptsABioExactlyAtThe160CharCap() throws Exception {
        // The boundary @Size(max = 160) accepts a value AT the cap; a 160-char bio persists.
        var who = caller("uid-bio-cap", "x@example.com");
        String atCap = "a".repeat(160);
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"bio\":\"" + atCap + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bio").value(atCap));
        assertThat(users.findByFirebaseUid("uid-bio-cap").orElseThrow().getBio())
                .isEqualTo(atCap);
    }

    @Test
    void patchMeRejectsABioOver160CharsWith400() throws Exception {
        // 161 chars exceeds @Size(max = 160) — a uniform 400 at the boundary, before persistence.
        String tooLong = "a".repeat(161);
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-bio-long", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"bio\":\"" + tooLong + "\"}"))
                .andExpect(status().isBadRequest());

        users.findByFirebaseUid("uid-bio-long")
                .ifPresent(u -> assertThat(u.getBio()).isNull());
    }

    @Test
    void patchMeAcceptsABlankBioWhichClearsToNull() throws Exception {
        // Blank is allowed (the optional-field contract). Set a bio, then send "" to clear it: the stored
        // value goes back to null (unset), not the empty string — so a cleared bio reads exactly like a
        // legacy never-written row (mirroring the nationality "" → null clear).
        var who = caller("uid-bio-clear", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"bio\":\"Loves hiking.\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bio").value("Loves hiking."));

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"bio\":\"\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bio").doesNotExist());

        assertThat(users.findByFirebaseUid("uid-bio-clear").orElseThrow().getBio())
                .isNull();
    }

    @Test
    void patchOmittingBioLeavesAPreviouslySetOneUnchanged() throws Exception {
        // Partial-PATCH (like nationality/gender/city): a PATCH that omits bio must leave a set value alone.
        var who = caller("uid-bio-keep", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"bio\":\"Always up for a plan.\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bio").value("Always up for a plan."));

        // Edit only the display name — bio must survive untouched.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Sara\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bio").value("Always up for a plan."));
        assertThat(users.findByFirebaseUid("uid-bio-keep").orElseThrow().getBio())
                .isEqualTo("Always up for a plan.");
    }
}
