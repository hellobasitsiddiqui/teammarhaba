package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsInAnyOrder;
import static org.hamcrest.Matchers.hasSize;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.google.firebase.auth.FirebaseAuth;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.interests.InterestCatalogue;
import com.teammarhaba.backend.interests.InterestCatalogueRepository;
import com.teammarhaba.backend.interests.UserInterest;
import com.teammarhaba.backend.interests.UserInterestRepository;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * TM-775 (closes TM-514): the interests user-selection API on {@code PATCH /api/v1/me}, plus the
 * {@code interests} field on {@code MeResponse} (GET + PATCH). Exercises the full controller →
 * bean-validation → {@code UserService.replaceInterests} → catalogue snapshot chain against a real
 * Postgres (Testcontainers), using <strong>real seeded catalogue labels</strong> (V45) so the happy
 * path needs no throwaway catalogue rows.
 *
 * <ul>
 *   <li>happy path — a valid set is saved as free-text snapshots and echoed back;</li>
 *   <li>snapshot correctness — {@code category} + {@code sourceInterestId} are copied from the catalogue;</li>
 *   <li>min enforcement — an empty set with the default {@code min = 1} is a {@code 400};</li>
 *   <li>max enforcement — over the default {@code max = 3} is a {@code 400};</li>
 *   <li>catalogue-only validation — an unknown label is a {@code 400};</li>
 *   <li>replace-semantics — a second PATCH replaces, never appends;</li>
 *   <li>partial-PATCH — omitting {@code interests} leaves the saved set unchanged;</li>
 *   <li>GET carries the saved interests, not just PATCH;</li>
 *   <li>a non-admin can save their own interests ({@code /me} is caller-owned, not admin-gated);</li>
 *   <li>a blank list element is a {@code 400} (bean validation on the element);</li>
 *   <li>duplicate labels are de-duplicated (one row, counted once against min/max).</li>
 * </ul>
 *
 * <p>{@link FirebaseAuth} is mocked so the Admin-SDK account-state block on {@code GET /me} degrades to
 * nulls rather than failing. An {@link #cleanUpInterests() @AfterEach} removes this class's
 * {@code user_interest} rows from the shared, never-rolled-back container.
 */
@AutoConfigureMockMvc
class MeInterestsIntegrationTest extends AbstractIntegrationTest {

    // Real, distinct seed labels from V45 (verified present via InterestCatalogueSeedIntegrationTest).
    private static final String WALKING = "Walking";
    private static final String HIKING = "Hiking & rambling";
    private static final String COFFEE = "Coffee & cafés";
    private static final String CYCLING = "Cycling";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @Autowired
    private UserInterestRepository userInterests;

    @Autowired
    private InterestCatalogueRepository catalogue;

    @Autowired
    private JdbcTemplate jdbc;

    @MockBean
    private FirebaseAuth firebaseAuth;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    /** Clean up every user_interest row this class creates (shared container, no rollback). */
    @AfterEach
    void cleanUpInterests() {
        jdbc.update(
                "delete from user_interest where user_id in"
                        + " (select id from users where firebase_uid like 'me-interests-%')");
    }

    private Long userIdOf(String uid) {
        return users.findByFirebaseUid(uid).orElseThrow().getId();
    }

    @Test
    void patchMeSavesInterestsHappyPath_returns200AndPersistsSnapshots() throws Exception {
        var who = caller("me-interests-happy", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + WALKING + "\",\"" + HIKING + "\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.interests", hasSize(2)))
                .andExpect(jsonPath("$.interests[*].label", containsInAnyOrder(WALKING, HIKING)))
                .andExpect(jsonPath("$.interests[0].category").isNotEmpty())
                .andExpect(jsonPath("$.interests[0].sourceInterestId").isNumber());

        List<UserInterest> saved = userInterests.findByUserId(userIdOf("me-interests-happy"));
        assertThat(saved).hasSize(2);
    }

    @Test
    void patchMeCopiesCategoryAndSourceIdFromCatalogue() throws Exception {
        // Snapshot correctness: label + category copied by value, source_interest_id = catalogue id.
        InterestCatalogue source = catalogue.findAllByOrderBySortWeightDescLabelAsc().stream()
                .filter(c -> c.getLabel().equals(WALKING))
                .findFirst()
                .orElseThrow(() -> new AssertionError("seed row for " + WALKING + " missing"));

        var who = caller("me-interests-snapshot", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + WALKING + "\"]}"))
                .andExpect(status().isOk());

        List<UserInterest> saved = userInterests.findByUserId(userIdOf("me-interests-snapshot"));
        assertThat(saved).hasSize(1);
        UserInterest snap = saved.get(0);
        assertThat(snap.getLabel()).isEqualTo(source.getLabel());
        assertThat(snap.getCategory()).isEqualTo(source.getCategory());
        assertThat(snap.getSourceInterestId()).isEqualTo(source.getId());
    }

    @Test
    void patchMeRejectsBelowMinWith400() throws Exception {
        // Default min = 1, so an empty set is a full-set-of-zero that violates the minimum → 400.
        var who = caller("me-interests-belowmin", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("at least 1")));

        // Nothing was inserted (the whole PATCH rolled back).
        users.findByFirebaseUid("me-interests-belowmin")
                .ifPresent(u -> assertThat(userInterests.findByUserId(u.getId())).isEmpty());
    }

    @Test
    void patchMeRejectsAboveMaxWith400() throws Exception {
        // Four distinct valid labels exceed the default max = 3 → 400, nothing saved.
        var who = caller("me-interests-abovemax", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + WALKING + "\",\"" + HIKING + "\",\"" + COFFEE + "\",\""
                                + CYCLING + "\"]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("at most 3")));

        users.findByFirebaseUid("me-interests-abovemax")
                .ifPresent(u -> assertThat(userInterests.findByUserId(u.getId())).isEmpty());
    }

    @Test
    void patchMeRejectsUnknownLabelWith400() throws Exception {
        // A label with no active catalogue row → catalogue-only validation rejects the PATCH.
        var who = caller("me-interests-unknown", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"Definitely Not A Real Interest\"]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("Unknown or retired")));

        users.findByFirebaseUid("me-interests-unknown")
                .ifPresent(u -> assertThat(userInterests.findByUserId(u.getId())).isEmpty());
    }

    @Test
    void patchMeReplacesFullSet_notAppend() throws Exception {
        var who = caller("me-interests-replace", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + WALKING + "\",\"" + HIKING + "\"]}"))
                .andExpect(status().isOk());

        // A second PATCH with a different single label must REPLACE, not append.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + COFFEE + "\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.interests", hasSize(1)))
                .andExpect(jsonPath("$.interests[0].label").value(COFFEE));

        List<UserInterest> saved = userInterests.findByUserId(userIdOf("me-interests-replace"));
        assertThat(saved).hasSize(1);
        assertThat(saved.get(0).getLabel()).isEqualTo(COFFEE);
    }

    @Test
    void patchOmittingInterestsLeavesSavedInterestsUnchanged() throws Exception {
        var who = caller("me-interests-omit", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + WALKING + "\"]}"))
                .andExpect(status().isOk());

        // A PATCH that omits interests (edits only displayName) must not touch the saved set.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"Nadia\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.displayName").value("Nadia"))
                .andExpect(jsonPath("$.interests", hasSize(1)))
                .andExpect(jsonPath("$.interests[0].label").value(WALKING));

        assertThat(userInterests.findByUserId(userIdOf("me-interests-omit"))).hasSize(1);
    }

    @Test
    void getMeReturnsSavedInterests() throws Exception {
        var who = caller("me-interests-get", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + WALKING + "\",\"" + HIKING + "\"]}"))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/me").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.interests", hasSize(2)))
                .andExpect(jsonPath("$.interests[*].label", containsInAnyOrder(WALKING, HIKING)));
    }

    @Test
    void nonAdminCanSaveOwnInterests() throws Exception {
        // /me is caller-owned, not admin-gated — a ROLE_USER principal succeeds. Guards against an
        // accidental RBAC coupling on the interests write path.
        var who = authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser("me-interests-user", "x@example.com"),
                null,
                List.of(new SimpleGrantedAuthority("ROLE_USER"))));
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + WALKING + "\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.interests", hasSize(1)));
    }

    @Test
    void patchMeRejectsBlankLabelElementWith400() throws Exception {
        // The element-level @NotBlank rejects a blank label at the bean-validation boundary.
        var who = caller("me-interests-blank", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + WALKING + "\",\"\"]}"))
                .andExpect(status().isBadRequest());

        users.findByFirebaseUid("me-interests-blank")
                .ifPresent(u -> assertThat(userInterests.findByUserId(u.getId())).isEmpty());
    }

    @Test
    void patchMeDeDuplicatesRepeatedLabels() throws Exception {
        // A double-sent label counts once against min/max and creates one row.
        var who = caller("me-interests-dedupe", "x@example.com");
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"interests\":[\"" + WALKING + "\",\"" + WALKING + "\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.interests", hasSize(1)));

        assertThat(userInterests.findByUserId(userIdOf("me-interests-dedupe"))).hasSize(1);
    }
}
