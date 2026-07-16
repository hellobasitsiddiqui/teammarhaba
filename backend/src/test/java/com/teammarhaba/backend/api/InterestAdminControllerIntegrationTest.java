package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.interests.InterestCatalogue;
import com.teammarhaba.backend.interests.InterestCatalogueRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin interests API (TM-774) end-to-end through the real security chain + Postgres:
 *
 * <ul>
 *   <li><b>RBAC, the TM-111 pattern</b> — anon → uniform 401, USER → uniform 403, a missing id → 404.</li>
 *   <li><b>Create</b> — audited (INTEREST_CREATED), highlighted-aware sort-weight default, DB-authoritative
 *       createdAt in the 201, validation (blank/oversize label, unknown category, duplicate active label).</li>
 *   <li><b>Edit</b> — partial PATCH incl. the nullable-Boolean highlight toggle; a no-op PATCH is silent;
 *       a rename onto an existing active label conflicts (409).</li>
 *   <li><b>Retire / restore</b> — retire ≠ delete (row kept, {@code retired=true}), idempotent, and
 *       restore re-checks label uniqueness (409 if the label was re-taken).</li>
 *   <li><b>List</b> — includes retired rows, tri-state active filter, category + q filters, ordering,
 *       and the unknown-sort-property 400.</li>
 * </ul>
 *
 * <p>The suite shares one never-rolled-back database, so this class uses a unique throwaway {@code
 * category} for its own rows and hard-deletes them (native, bypassing {@code @SQLRestriction}) in an
 * {@code @AfterEach}, never touching the 101 seed rows — the {@code UserInterestSnapshotIntegrationTest}
 * cleanup pattern. Assertions filter on this class's own rows rather than exact table contents.
 */
@AutoConfigureMockMvc
class InterestAdminControllerIntegrationTest extends AbstractIntegrationTest {

    /** A throwaway category unique to this class, so cleanup can target exactly its rows. */
    private static final String TEST_CATEGORY = "Food & Drink";

    /** Native marker used for cleanup — every label this class seeds starts with it. */
    private static final String LABEL_PREFIX = "TM774-";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private InterestCatalogueRepository catalogue;

    @Autowired
    private AuditService audit;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterEach
    void cleanUpThrowawayRows() {
        // Native delete bypasses @SQLRestriction so tombstoned (retired) throwaway rows are removed too;
        // keyed on this class's label prefix so the 101 seed rows are never touched.
        jdbc.update("delete from interest_catalogue where label like ?", LABEL_PREFIX + "%");
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

    /** Seed an interest directly through the repository (label auto-prefixed for cleanup). */
    private InterestCatalogue seed(String label, boolean highlighted, int weight) {
        // Truncate the seed timestamp to microseconds — Postgres TIMESTAMPTZ is microsecond-precision and
        // rounds on store, so a nanosecond Instant.now() (Linux/CI) would not round-trip losslessly. Without
        // this, the in-memory seeded.getUpdatedAt() (e.g. ...997Z) does not equal the DB-reloaded value (...Z)
        // in the no-op-PATCH equality assertion (noOpPatchIsSilent). See blackboard TM-419 (precision flake).
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        return catalogue.saveAndFlush(
                new InterestCatalogue(LABEL_PREFIX + label, TEST_CATEGORY, highlighted, weight, now));
    }

    private String createBody(String label) {
        return """
                { "label": "%s", "category": "%s", "highlighted": true }
                """
                .formatted(LABEL_PREFIX + label, TEST_CATEGORY);
    }

    private List<AuditAction> auditActionsFor(long id) {
        return audit.search(null, "Interest", String.valueOf(id), PageRequest.of(0, 20)).getContent().stream()
                .map(AuditEvent::getAction)
                .toList();
    }

    // --- RBAC: the TM-111 401/403/404 pattern ---

    @Test
    void anonymousGets401() throws Exception {
        mockMvc.perform(get("/api/v1/admin/interests"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminGetsUniform403() throws Exception {
        mockMvc.perform(get("/api/v1/admin/interests").with(regularUser("int-plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }

    @Test
    void nonAdminCannotCreateEditRetireOrSetConfig() throws Exception {
        InterestCatalogue seeded = seed("rbac", false, 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/interests")
                        .with(regularUser("int-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createBody("rbac-create")))
                .andExpect(status().isForbidden());

        mockMvc.perform(patch("/api/v1/admin/interests/{id}", id)
                        .with(regularUser("int-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"highlighted\":true}"))
                .andExpect(status().isForbidden());

        mockMvc.perform(post("/api/v1/admin/interests/{id}/retire", id).with(regularUser("int-plain-user")))
                .andExpect(status().isForbidden());

        mockMvc.perform(post("/api/v1/admin/interests/{id}/restore", id).with(regularUser("int-plain-user")))
                .andExpect(status().isForbidden());

        mockMvc.perform(put("/api/v1/admin/interests/config")
                        .with(regularUser("int-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"minSelections\":2,\"maxSelections\":5}"))
                .andExpect(status().isForbidden());
    }

    // --- Create ---

    @Test
    void adminCreatesInterest() throws Exception {
        String body = mockMvc.perform(post("/api/v1/admin/interests")
                        .with(admin("int-admin-create"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createBody("Latte Art"))) // highlighted=true, no sortWeight
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").isNumber())
                .andExpect(jsonPath("$.label").value(LABEL_PREFIX + "Latte Art"))
                .andExpect(jsonPath("$.category").value(TEST_CATEGORY))
                .andExpect(jsonPath("$.highlighted").value(true))
                .andExpect(jsonPath("$.sortWeight").value(100)) // highlighted default
                .andExpect(jsonPath("$.active").value(true))
                .andExpect(jsonPath("$.retired").value(false))
                .andExpect(jsonPath("$.createdAt").isNotEmpty())
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(body).<Number>read("$.id").longValue();

        assertThat(catalogue.findById(id)).isPresent();
        assertThat(auditActionsFor(id)).contains(AuditAction.INTEREST_CREATED);
    }

    @Test
    void createDefaultsSortWeightZeroWhenNotHighlighted() throws Exception {
        mockMvc.perform(post("/api/v1/admin/interests")
                        .with(admin("int-admin-create"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                { "label": "%s", "category": "%s", "highlighted": false }
                                """
                                .formatted(LABEL_PREFIX + "Plain", TEST_CATEGORY)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.sortWeight").value(0));
    }

    @Test
    void createHonoursExplicitSortWeight() throws Exception {
        mockMvc.perform(post("/api/v1/admin/interests")
                        .with(admin("int-admin-create"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                { "label": "%s", "category": "%s", "highlighted": false, "sortWeight": 250 }
                                """
                                .formatted(LABEL_PREFIX + "Weighted", TEST_CATEGORY)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.sortWeight").value(250));
    }

    @Test
    void createRejectsBlankLabel() throws Exception {
        mockMvc.perform(post("/api/v1/admin/interests")
                        .with(admin("int-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{ \"label\": \"\", \"category\": \"" + TEST_CATEGORY + "\", \"highlighted\": false }"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'label')]").exists());
    }

    @Test
    void createRejectsOversizeLabel() throws Exception {
        String oversize = LABEL_PREFIX + "x".repeat(121); // label @Size(max = 120)
        mockMvc.perform(post("/api/v1/admin/interests")
                        .with(admin("int-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{ \"label\": \"" + oversize + "\", \"category\": \"" + TEST_CATEGORY
                                + "\", \"highlighted\": false }"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'label')]").exists());
    }

    @Test
    void createRejectsUnknownCategory() throws Exception {
        mockMvc.perform(post("/api/v1/admin/interests")
                        .with(admin("int-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{ \"label\": \"" + LABEL_PREFIX + "Bad\", \"category\": \"Nonsense\", "
                                + "\"highlighted\": false }"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                // The @AssertTrue message names the known-category rule (field is the derived bean property).
                .andExpect(jsonPath("$.errors[?(@.message =~ /.*known interest categories.*/)]").exists());
    }

    @Test
    void createRejectsDuplicateActiveLabel() throws Exception {
        seed("Dup", false, 0); // an active row already holds LABEL_PREFIX + "Dup"
        mockMvc.perform(post("/api/v1/admin/interests")
                        .with(admin("int-admin-dup"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createBody("Dup")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.status").value(409));
    }

    // --- Edit (PATCH) ---

    @Test
    void adminEditsLabelAndCategory() throws Exception {
        InterestCatalogue seeded = seed("Edit me", false, 0);
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/interests/{id}", id)
                        .with(admin("int-admin-edit"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"label\":\"" + LABEL_PREFIX + "Edited\",\"category\":\"Sport & Fitness\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.label").value(LABEL_PREFIX + "Edited"))
                .andExpect(jsonPath("$.category").value("Sport & Fitness"));

        InterestCatalogue reloaded = catalogue.findById(id).orElseThrow();
        assertThat(reloaded.getLabel()).isEqualTo(LABEL_PREFIX + "Edited");
        assertThat(reloaded.getCategory()).isEqualTo("Sport & Fitness");
        assertThat(reloaded.getUpdatedAt()).isAfter(seeded.getUpdatedAt());
        assertThat(auditActionsFor(id)).contains(AuditAction.INTEREST_UPDATED);
    }

    @Test
    void patchHighlightToggleOnlyChangesHighlight() throws Exception {
        InterestCatalogue seeded = seed("Toggle", false, 42);
        long id = seeded.getId();

        // Explicitly set highlighted true — nothing else changes.
        mockMvc.perform(patch("/api/v1/admin/interests/{id}", id)
                        .with(admin("int-admin-toggle"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"highlighted\":true}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.highlighted").value(true))
                .andExpect(jsonPath("$.label").value(LABEL_PREFIX + "Toggle"))
                .andExpect(jsonPath("$.category").value(TEST_CATEGORY))
                .andExpect(jsonPath("$.sortWeight").value(42));

        // Explicitly set highlighted false — proves nullable Boolean un-highlights only when sent.
        mockMvc.perform(patch("/api/v1/admin/interests/{id}", id)
                        .with(admin("int-admin-toggle"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"highlighted\":false}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.highlighted").value(false));
    }

    @Test
    void patchSortWeightOnly() throws Exception {
        InterestCatalogue seeded = seed("Weight", true, 0);
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/interests/{id}", id)
                        .with(admin("int-admin-weight"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sortWeight\":500}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sortWeight").value(500))
                .andExpect(jsonPath("$.highlighted").value(true))
                .andExpect(jsonPath("$.label").value(LABEL_PREFIX + "Weight"));
    }

    @Test
    void noOpPatchIsSilent() throws Exception {
        InterestCatalogue seeded = seed("Noop", false, 0);
        long id = seeded.getId();
        Instant before = seeded.getUpdatedAt();

        mockMvc.perform(patch("/api/v1/admin/interests/{id}", id)
                        .with(admin("int-admin-noop"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isOk());

        // No touch (updatedAt unchanged) and no audit.
        InterestCatalogue reloaded = catalogue.findById(id).orElseThrow();
        assertThat(reloaded.getUpdatedAt()).isEqualTo(before);
        assertThat(auditActionsFor(id)).doesNotContain(AuditAction.INTEREST_UPDATED);
    }

    @Test
    void patchRenameToExistingActiveLabelConflicts() throws Exception {
        InterestCatalogue a = seed("RenameA", false, 0);
        InterestCatalogue b = seed("RenameB", false, 0);

        mockMvc.perform(patch("/api/v1/admin/interests/{id}", a.getId())
                        .with(admin("int-admin-rename"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"label\":\"" + b.getLabel() + "\"}"))
                .andExpect(status().isConflict());
    }

    @Test
    void patchUnknownIdIs404() throws Exception {
        mockMvc.perform(patch("/api/v1/admin/interests/{id}", 999_999L)
                        .with(admin("int-admin-404"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"highlighted\":true}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    // --- Retire / restore (retire-not-delete invariant) ---

    @Test
    void retireSoftDeletesKeepingRow() throws Exception {
        InterestCatalogue seeded = seed("Retire me", false, 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/interests/{id}/retire", id).with(admin("int-admin-retire")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(false))
                .andExpect(jsonPath("$.retired").value(true))
                .andExpect(jsonPath("$.deletedAt").isNotEmpty());

        // Retire ≠ delete: the row physically survives (native count = 1, bypassing @SQLRestriction).
        Integer rows = jdbc.queryForObject("select count(*) from interest_catalogue where id = ?", Integer.class, id);
        assertThat(rows).isEqualTo(1);
        assertThat(auditActionsFor(id)).contains(AuditAction.INTEREST_RETIRED);
    }

    @Test
    void retireIsIdempotent() throws Exception {
        InterestCatalogue seeded = seed("Retire twice", false, 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/interests/{id}/retire", id).with(admin("int-admin-retire")))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/admin/interests/{id}/retire", id).with(admin("int-admin-retire")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.retired").value(true));

        // Idempotent: only the first retire audited.
        assertThat(auditActionsFor(id)).containsOnlyOnce(AuditAction.INTEREST_RETIRED);
    }

    @Test
    void retiredRowHiddenFromUserFacingListButVisibleToAdmin() throws Exception {
        InterestCatalogue seeded = seed("Hidden", false, 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/interests/{id}/retire", id).with(admin("int-admin-retire")))
                .andExpect(status().isOk());

        // The restriction-honouring repository read no longer sees it.
        assertThat(catalogue.findById(id)).isEmpty();

        // But the admin GET-by-id resolves it (retired included) ...
        mockMvc.perform(get("/api/v1/admin/interests/{id}", id).with(admin("int-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.retired").value(true));

        // ... and the admin list (no active filter) contains it as retired.
        mockMvc.perform(get("/api/v1/admin/interests")
                        .param("size", "100")
                        .param("category", TEST_CATEGORY)
                        .with(admin("int-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + id + ")].retired").value(true));
    }

    @Test
    void restoreUnretires() throws Exception {
        InterestCatalogue seeded = seed("Restore me", false, 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/interests/{id}/retire", id).with(admin("int-admin-restore")))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/admin/interests/{id}/restore", id).with(admin("int-admin-restore")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(true))
                .andExpect(jsonPath("$.retired").value(false))
                .andExpect(jsonPath("$.deletedAt").doesNotExist());

        assertThat(catalogue.findById(id)).isPresent(); // visible again
        assertThat(auditActionsFor(id)).contains(AuditAction.INTEREST_RESTORED);
    }

    @Test
    void restoreIsIdempotentOnActiveRow() throws Exception {
        InterestCatalogue seeded = seed("Already active", false, 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/interests/{id}/restore", id).with(admin("int-admin-restore")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.retired").value(false));

        assertThat(auditActionsFor(id)).doesNotContain(AuditAction.INTEREST_RESTORED);
    }

    @Test
    void restoreConflictsIfLabelReTaken() throws Exception {
        InterestCatalogue first = seed("Reused", false, 0);
        long firstId = first.getId();

        mockMvc.perform(post("/api/v1/admin/interests/{id}/retire", firstId).with(admin("int-admin-restore")))
                .andExpect(status().isOk());

        // A new active row grabs the same label while the first is retired.
        seed("Reused", false, 0);

        // Restoring the first would collide with the partial-unique index → 409.
        mockMvc.perform(post("/api/v1/admin/interests/{id}/restore", firstId).with(admin("int-admin-restore")))
                .andExpect(status().isConflict());
    }

    @Test
    void restoreUnknownIdIs404() throws Exception {
        mockMvc.perform(post("/api/v1/admin/interests/{id}/restore", 999_999L).with(admin("int-admin-404")))
                .andExpect(status().isNotFound());
    }

    @Test
    void retireUnknownIdIs404() throws Exception {
        mockMvc.perform(post("/api/v1/admin/interests/{id}/retire", 999_999L).with(admin("int-admin-404")))
                .andExpect(status().isNotFound());
    }

    // --- Admin list filters + ordering ---

    @Test
    void adminListIncludesRetiredAndFiltersOnActive() throws Exception {
        InterestCatalogue active = seed("List-Active", false, 0);
        InterestCatalogue toRetire = seed("List-Retired", false, 0);
        mockMvc.perform(post("/api/v1/admin/interests/{id}/retire", toRetire.getId()).with(admin("int-admin-list")))
                .andExpect(status().isOk());

        // No active filter: BOTH the active and the retired throwaway row appear.
        mockMvc.perform(get("/api/v1/admin/interests")
                        .param("size", "100")
                        .param("category", TEST_CATEGORY)
                        .with(admin("int-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + active.getId() + ")]").exists())
                .andExpect(jsonPath("$.items[?(@.id == " + toRetire.getId() + ")].retired").value(true));

        // active=true excludes the retired one.
        mockMvc.perform(get("/api/v1/admin/interests")
                        .param("size", "100")
                        .param("category", TEST_CATEGORY)
                        .param("active", "true")
                        .with(admin("int-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + active.getId() + ")]").exists())
                .andExpect(jsonPath("$.items[?(@.id == " + toRetire.getId() + ")]").doesNotExist());

        // active=false shows only the retired one.
        mockMvc.perform(get("/api/v1/admin/interests")
                        .param("size", "100")
                        .param("category", TEST_CATEGORY)
                        .param("active", "false")
                        .with(admin("int-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + toRetire.getId() + ")]").exists())
                .andExpect(jsonPath("$.items[?(@.id == " + active.getId() + ")]").doesNotExist());
    }

    @Test
    void adminListQSubstringCaseInsensitive() throws Exception {
        InterestCatalogue seeded = seed("UniqueQterm", false, 0);

        mockMvc.perform(get("/api/v1/admin/interests")
                        .param("size", "100")
                        .param("q", "uniqueqterm") // lower-case — must still match
                        .with(admin("int-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + seeded.getId() + ")]").exists());
    }

    @Test
    void adminListOrdersBySortWeightDescThenLabel() throws Exception {
        InterestCatalogue low = seed("ZZZ-low", false, 10);
        InterestCatalogue high = seed("AAA-high", false, 900);

        String body = mockMvc.perform(get("/api/v1/admin/interests")
                        .param("size", "100")
                        .param("category", TEST_CATEGORY)
                        .with(admin("int-admin-list")))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();

        List<Integer> ids = JsonPath.parse(body).read("$.items[*].id");
        // The higher sort_weight row must come before the lower one in the default ordering.
        assertThat(ids.indexOf(high.getId().intValue())).isLessThan(ids.indexOf(low.getId().intValue()));
    }

    @Test
    void adminListRejectsUnknownSortProperty() throws Exception {
        mockMvc.perform(get("/api/v1/admin/interests")
                        .param("sort", "deletedAt,desc")
                        .with(admin("int-admin-sort")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Invalid request"));
    }
}
