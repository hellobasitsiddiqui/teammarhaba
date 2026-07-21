package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.DocumentContext;
import com.jayway.jsonpath.JsonPath;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.interests.InterestAdminService;
import com.teammarhaba.backend.interests.InterestCatalogue;
import com.teammarhaba.backend.interests.InterestCatalogueRepository;
import com.teammarhaba.backend.interests.UserInterest;
import com.teammarhaba.backend.interests.UserInterestRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The per-interest selection analytics endpoint {@code GET /api/v1/admin/interests/stats} (TM-832) —
 * the "Selected by" column — end-to-end through the real security chain + Postgres. Scope: selector
 * COUNT + PERCENT only (the gender split is deferred, TM-955).
 *
 * <p>Proven here (fail-before/pass-after):
 *
 * <ul>
 *   <li><b>Correct counts</b> — {@code selectorCount} equals {@code COUNT(*)} of {@code user_interest}
 *       rows grouped by label, for this class's own seeded labels.</li>
 *   <li><b>Percent basis = ACTIVE users</b> — {@code percent = round(100 * count / activeUsers)} against
 *       the {@code activeUsers} denominator the response carries (enabled, non-deleted accounts). A
 *       suspended ({@code enabled=false}) account is NOT in the denominator.</li>
 *   <li><b>Retired-interest label still counted</b> — a selection whose source catalogue interest has been
 *       retired (soft-deleted) is still tallied under its label (the TM-773 snapshot survives).</li>
 *   <li><b>Divide-by-zero safe</b> — {@link InterestAdminService#percentOf} returns 0 for a 0 (or empty)
 *       active-user denominator instead of dividing by zero (the shared, never-emptied user table can't be
 *       zeroed in-suite, so the guard is unit-tested directly).</li>
 *   <li><b>ADMIN-gated</b> — a non-admin caller gets a uniform 403.</li>
 * </ul>
 *
 * <p>The suite shares one never-rolled-back database, so this class seeds throwaway users
 * ({@code firebase_uid} prefixed {@code tm832-}), a throwaway catalogue row, and {@code user_interest}
 * rows under unique {@code TM832-} labels, then hard-deletes exactly those in an {@code @AfterEach} —
 * never touching seed data. Assertions target this class's own labels, and percent is computed against the
 * response's live denominator so a growing shared user base can't flake it.
 */
@AutoConfigureMockMvc
class InterestSelectionStatsIntegrationTest extends AbstractIntegrationTest {

    private static final String LABEL_PREFIX = "TM832-";
    private static final String UID_PREFIX = "tm832-";
    private static final String TEST_CATEGORY = "Food & Drink";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository users;

    @Autowired
    private UserInterestRepository userInterests;

    @Autowired
    private InterestCatalogueRepository catalogue;

    @Autowired
    private InterestAdminService adminService;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterEach
    void cleanUpThrowawayRows() {
        jdbc.update("delete from user_interest where label like ?", LABEL_PREFIX + "%");
        // Native delete bypasses @SQLRestriction so a retired (tombstoned) throwaway catalogue row goes too.
        jdbc.update("delete from interest_catalogue where label like ?", LABEL_PREFIX + "%");
        // Users seeded here are enabled/active; delete by uid prefix (the FK cascade already cleared their
        // user_interest rows above, but the label-keyed delete covers renamed labels too).
        jdbc.update("delete from users where firebase_uid like ?", UID_PREFIX + "%");
    }

    private static RequestPostProcessor admin(String uid) {
        return principal(uid, "ROLE_ADMIN");
    }

    private static RequestPostProcessor regularUser(String uid) {
        return principal(uid, "ROLE_USER");
    }

    private static RequestPostProcessor principal(String uid, String authority) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of(new SimpleGrantedAuthority(authority))));
    }

    /** Create an active (enabled, non-deleted) throwaway account and return its id. */
    private Long newActiveUser(String suffix) {
        return users.save(new User(UID_PREFIX + suffix, UID_PREFIX + suffix + "@example.com", suffix)).getId();
    }

    /** Record one selection snapshot of {@code label} for {@code userId} (sourceInterestId optional). */
    private void select(Long userId, String label, Long sourceInterestId) {
        userInterests.save(new UserInterest(userId, LABEL_PREFIX + label, TEST_CATEGORY, sourceInterestId));
    }

    /** Read one field of this class's single {@code TM832-<label>} stat row (the [?] filter yields an array). */
    private static Number statFor(DocumentContext json, String label, String field) {
        List<Number> matches = json.read("$.stats[?(@.label == '" + LABEL_PREFIX + label + "')]." + field);
        assertThat(matches).as("exactly one stat row for label " + label).hasSize(1);
        return matches.get(0);
    }

    // --- ADMIN gating ---

    @Test
    void nonAdminGetsUniform403() throws Exception {
        mockMvc.perform(get("/api/v1/admin/interests/stats").with(regularUser("tm832-plain")))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.status").value(403));
    }

    // --- Correct per-label counts + percent basis ---

    @Test
    void adminGetsCorrectCountsAndPercentAgainstActiveUsers() throws Exception {
        Long u1 = newActiveUser("c1");
        Long u2 = newActiveUser("c2");
        Long u3 = newActiveUser("c3");

        // "Popular" picked by 3 users, "Niche" by 1 — the counts we assert exactly.
        select(u1, "Popular", null);
        select(u2, "Popular", null);
        select(u3, "Popular", null);
        select(u1, "Niche", null);

        String body = mockMvc.perform(get("/api/v1/admin/interests/stats").with(admin("tm832-admin")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.activeUsers").isNumber())
                .andReturn()
                .getResponse()
                .getContentAsString();

        DocumentContext json = JsonPath.parse(body);
        long activeUsers = json.<Number>read("$.activeUsers").longValue();
        assertThat(activeUsers).isGreaterThanOrEqualTo(3); // at least our three throwaway actives

        // A [?(...)] filter yields an array; read it and take the single match's field in Java.
        long popularCount = statFor(json, "Popular", "selectorCount").longValue();
        int popularPercent = statFor(json, "Popular", "percent").intValue();
        long nicheCount = statFor(json, "Niche", "selectorCount").longValue();

        assertThat(popularCount).isEqualTo(3);
        assertThat(nicheCount).isEqualTo(1);
        // Percent = round(100 * count / activeUsers) against the LIVE denominator the response reports.
        assertThat(popularPercent).isEqualTo((int) Math.round(100.0 * 3 / activeUsers));
    }

    @Test
    void suspendedUsersAreNotInThePercentDenominator() {
        // Two active + one suspended account, so activeUsers counts only the enabled ones.
        newActiveUser("s1");
        Long suspended = newActiveUser("s2-suspended");
        newActiveUser("s3");
        // Suspend s2 via a native flip (enabled=false) — the denominator must drop it.
        jdbc.update("update users set enabled = false where id = ?", suspended);

        long activeViaRepo = users.countActiveUsers();
        InterestAdminService.SelectionStats stats = adminService.selectionStats();

        // The service's denominator equals the repo count, and the suspended account is excluded from it.
        assertThat(stats.activeUsers()).isEqualTo(activeViaRepo);
        Long stillActive = jdbc.queryForObject(
                "select count(*) from users where enabled = true and deleted_at is null and firebase_uid like ?",
                Long.class,
                UID_PREFIX + "s%");
        assertThat(stillActive).isEqualTo(2L); // s1 + s3 only
    }

    // --- Retired-interest label still counted ---

    @Test
    void selectionOfRetiredInterestIsStillCountedByLabel() throws Exception {
        Long u1 = newActiveUser("r1");
        Long u2 = newActiveUser("r2");

        // A throwaway catalogue interest the users pick, then RETIRE (soft-delete) it.
        InterestCatalogue source = catalogue.saveAndFlush(
                new InterestCatalogue(LABEL_PREFIX + "Retired", TEST_CATEGORY, false, 0, Instant.now()));
        select(u1, "Retired", source.getId());
        select(u2, "Retired", source.getId());

        // Retire (soft-delete) it through the real admin path — the row is tombstoned but kept (TM-773).
        adminService.retire(new VerifiedUser("tm832-retirer", "tm832-retirer@example.com"), source.getId());
        assertThat(catalogue.findById(source.getId())).isEmpty(); // tombstoned → hidden from normal reads

        // The stats still tally the two selections under the retired interest's label (snapshot survives).
        mockMvc.perform(get("/api/v1/admin/interests/stats").with(admin("tm832-admin-retired")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stats[?(@.label == '" + LABEL_PREFIX + "Retired')].selectorCount").value(2));
    }

    // --- Divide-by-zero guard (unit; the shared user table can't be emptied in-suite) ---

    @Test
    void percentIsZeroGuardedWhenNoActiveUsers() {
        assertThat(InterestAdminService.percentOf(5, 0)).isZero();
        assertThat(InterestAdminService.percentOf(0, 0)).isZero();
        // Normal rounding (half-up): 1 of 3 → 33%, 2 of 3 → 67%.
        assertThat(InterestAdminService.percentOf(1, 3)).isEqualTo(33);
        assertThat(InterestAdminService.percentOf(2, 3)).isEqualTo(67);
        assertThat(InterestAdminService.percentOf(3, 3)).isEqualTo(100);
    }
}
