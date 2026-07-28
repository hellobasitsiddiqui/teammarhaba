package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditService;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.city.CityCatalogue;
import com.teammarhaba.backend.city.CityCatalogueRepository;
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
 * The admin cities API (TM-1089) end-to-end through the real security chain + Postgres, mirroring
 * {@link InterestAdminControllerIntegrationTest}:
 *
 * <ul>
 *   <li><b>RBAC, the TM-111 pattern</b> — anon → uniform 401, USER → uniform 403, a missing id → 404.</li>
 *   <li><b>Create</b> — audited (CITY_CREATED), sort-weight default, DB-authoritative createdAt in the
 *       201, icon/geo round-trip, validation (blank/oversize name, out-of-range geo, duplicate name).</li>
 *   <li><b>Edit</b> — partial PATCH; a no-op PATCH is silent; a rename onto an existing active name 409s.</li>
 *   <li><b>Retire / restore</b> — retire ≠ delete (row kept, {@code retired=true}), idempotent, and
 *       restore re-checks name uniqueness (409 if the name was re-taken).</li>
 *   <li><b>List</b> — includes retired rows, tri-state active filter, q filter, and unknown-sort 400.</li>
 * </ul>
 *
 * <p>The suite shares one never-rolled-back database, so it uses a throwaway {@code name} prefix and
 * hard-deletes its own rows (native, bypassing {@code @SQLRestriction}) in {@code @AfterEach}, never
 * touching the four V54 seed cities.
 */
@AutoConfigureMockMvc
class CityAdminControllerIntegrationTest extends AbstractIntegrationTest {

    /** A throwaway country + name prefix unique to this class, so cleanup can target exactly its rows. */
    private static final String TEST_COUNTRY = "Testonia";

    private static final String NAME_PREFIX = "TM1089-";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private CityCatalogueRepository catalogue;

    @Autowired
    private AuditService audit;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterEach
    void cleanUpThrowawayRows() {
        // Native delete bypasses @SQLRestriction so tombstoned (retired) throwaway rows are removed too;
        // keyed on this class's name prefix so the four V54 seed rows are never touched.
        jdbc.update("delete from city_catalogue where name like ?", NAME_PREFIX + "%");
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

    /** Seed a city directly through the repository (name auto-prefixed for cleanup). */
    private CityCatalogue seed(String name, int weight) {
        // Truncate to microseconds — Postgres TIMESTAMPTZ is microsecond-precision, so a nanosecond
        // Instant.now() would not round-trip losslessly and the no-op-PATCH equality assertion would flake
        // (see the interests suite / blackboard TM-419).
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        return catalogue.saveAndFlush(new CityCatalogue(NAME_PREFIX + name, TEST_COUNTRY, weight, now));
    }

    private String createBody(String name) {
        return """
                { "name": "%s", "country": "%s" }
                """
                .formatted(NAME_PREFIX + name, TEST_COUNTRY);
    }

    private List<AuditAction> auditActionsFor(long id) {
        return audit.search(null, "City", String.valueOf(id), PageRequest.of(0, 20)).getContent().stream()
                .map(AuditEvent::getAction)
                .toList();
    }

    // --- RBAC: the TM-111 401/403/404 pattern ---

    @Test
    void anonymousGets401() throws Exception {
        mockMvc.perform(get("/api/v1/admin/cities"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminGetsUniform403() throws Exception {
        mockMvc.perform(get("/api/v1/admin/cities").with(regularUser("city-plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Forbidden"))
                .andExpect(jsonPath("$.status").value(403));
    }

    @Test
    void nonAdminCannotCreateEditRetireOrRestore() throws Exception {
        CityCatalogue seeded = seed("rbac", 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/cities")
                        .with(regularUser("city-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createBody("rbac-create")))
                .andExpect(status().isForbidden());

        mockMvc.perform(patch("/api/v1/admin/cities/{id}", id)
                        .with(regularUser("city-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"country\":\"Elsewhere\"}"))
                .andExpect(status().isForbidden());

        mockMvc.perform(post("/api/v1/admin/cities/{id}/retire", id).with(regularUser("city-plain-user")))
                .andExpect(status().isForbidden());

        mockMvc.perform(post("/api/v1/admin/cities/{id}/restore", id).with(regularUser("city-plain-user")))
                .andExpect(status().isForbidden());
    }

    // --- Create ---

    @Test
    void adminCreatesCityWithIconAndGeo() throws Exception {
        String body = mockMvc.perform(post("/api/v1/admin/cities")
                        .with(admin("city-admin-create"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                { "name": "%s", "country": "%s", "iconEmoji": "🏙️",
                                  "geoLat": 51.5, "geoLng": -0.12, "sortWeight": 5 }
                                """
                                .formatted(NAME_PREFIX + "Metropolis", TEST_COUNTRY)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").isNumber())
                .andExpect(jsonPath("$.name").value(NAME_PREFIX + "Metropolis"))
                .andExpect(jsonPath("$.country").value(TEST_COUNTRY))
                .andExpect(jsonPath("$.iconEmoji").value("🏙️"))
                .andExpect(jsonPath("$.geoLat").value(51.5))
                .andExpect(jsonPath("$.geoLng").value(-0.12))
                .andExpect(jsonPath("$.sortWeight").value(5))
                .andExpect(jsonPath("$.active").value(true))
                .andExpect(jsonPath("$.retired").value(false))
                .andExpect(jsonPath("$.createdAt").isNotEmpty())
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(body).<Number>read("$.id").longValue();

        assertThat(catalogue.findById(id)).isPresent();
        assertThat(auditActionsFor(id)).contains(AuditAction.CITY_CREATED);
    }

    @Test
    void createDefaultsSortWeightZero() throws Exception {
        mockMvc.perform(post("/api/v1/admin/cities")
                        .with(admin("city-admin-create"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createBody("Plain")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.sortWeight").value(0))
                .andExpect(jsonPath("$.iconEmoji").doesNotExist()); // no icon → null, omitted
    }

    @Test
    void createRejectsBlankName() throws Exception {
        mockMvc.perform(post("/api/v1/admin/cities")
                        .with(admin("city-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{ \"name\": \"\", \"country\": \"" + TEST_COUNTRY + "\" }"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'name')]").exists());
    }

    @Test
    void createRejectsOversizeName() throws Exception {
        String oversize = NAME_PREFIX + "x".repeat(121); // name @Size(max = 120)
        mockMvc.perform(post("/api/v1/admin/cities")
                        .with(admin("city-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{ \"name\": \"" + oversize + "\", \"country\": \"" + TEST_COUNTRY + "\" }"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'name')]").exists());
    }

    @Test
    void createRejectsOutOfRangeLatitude() throws Exception {
        mockMvc.perform(post("/api/v1/admin/cities")
                        .with(admin("city-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{ \"name\": \"" + NAME_PREFIX + "Polar\", \"country\": \"" + TEST_COUNTRY
                                + "\", \"geoLat\": 120.0 }"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'geoLat')]").exists());
    }

    @Test
    void createRejectsDuplicateActiveName() throws Exception {
        seed("Dup", 0); // an active row already holds NAME_PREFIX + "Dup"
        mockMvc.perform(post("/api/v1/admin/cities")
                        .with(admin("city-admin-dup"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(createBody("Dup")))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.status").value(409));
    }

    // --- Edit (PATCH) ---

    @Test
    void adminEditsCountryAndSortWeight() throws Exception {
        CityCatalogue seeded = seed("Edit me", 0);
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/cities/{id}", id)
                        .with(admin("city-admin-edit"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"country\":\"Newland\",\"sortWeight\":99}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.country").value("Newland"))
                .andExpect(jsonPath("$.sortWeight").value(99));

        CityCatalogue reloaded = catalogue.findById(id).orElseThrow();
        assertThat(reloaded.getCountry()).isEqualTo("Newland");
        assertThat(reloaded.getSortWeight()).isEqualTo(99);
        assertThat(reloaded.getUpdatedAt()).isAfter(seeded.getUpdatedAt());
        assertThat(auditActionsFor(id)).contains(AuditAction.CITY_UPDATED);
    }

    @Test
    void noOpPatchIsSilent() throws Exception {
        CityCatalogue seeded = seed("Noop", 0);
        long id = seeded.getId();
        Instant before = seeded.getUpdatedAt();

        mockMvc.perform(patch("/api/v1/admin/cities/{id}", id)
                        .with(admin("city-admin-noop"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isOk());

        CityCatalogue reloaded = catalogue.findById(id).orElseThrow();
        assertThat(reloaded.getUpdatedAt()).isEqualTo(before);
        assertThat(auditActionsFor(id)).doesNotContain(AuditAction.CITY_UPDATED);
    }

    @Test
    void patchRenameToExistingActiveNameConflicts() throws Exception {
        CityCatalogue a = seed("RenameA", 0);
        CityCatalogue b = seed("RenameB", 0);

        mockMvc.perform(patch("/api/v1/admin/cities/{id}", a.getId())
                        .with(admin("city-admin-rename"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"" + b.getName() + "\"}"))
                .andExpect(status().isConflict());
    }

    @Test
    void patchUnknownIdIs404() throws Exception {
        mockMvc.perform(patch("/api/v1/admin/cities/{id}", 999_999L)
                        .with(admin("city-admin-404"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sortWeight\":1}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));
    }

    // --- Retire / restore (retire-not-delete invariant) ---

    @Test
    void retireSoftDeletesKeepingRow() throws Exception {
        CityCatalogue seeded = seed("Retire me", 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/cities/{id}/retire", id).with(admin("city-admin-retire")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(false))
                .andExpect(jsonPath("$.retired").value(true))
                .andExpect(jsonPath("$.deletedAt").isNotEmpty());

        // Retire ≠ delete: the row physically survives (native count = 1, bypassing @SQLRestriction).
        Integer rows = jdbc.queryForObject("select count(*) from city_catalogue where id = ?", Integer.class, id);
        assertThat(rows).isEqualTo(1);
        assertThat(auditActionsFor(id)).contains(AuditAction.CITY_RETIRED);
    }

    @Test
    void retireIsIdempotent() throws Exception {
        CityCatalogue seeded = seed("Retire twice", 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/cities/{id}/retire", id).with(admin("city-admin-retire")))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/admin/cities/{id}/retire", id).with(admin("city-admin-retire")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.retired").value(true));

        assertThat(auditActionsFor(id)).containsOnlyOnce(AuditAction.CITY_RETIRED);
    }

    @Test
    void retiredRowHiddenFromUserFacingListButVisibleToAdmin() throws Exception {
        CityCatalogue seeded = seed("Hidden", 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/cities/{id}/retire", id).with(admin("city-admin-retire")))
                .andExpect(status().isOk());

        // The restriction-honouring repository read no longer sees it.
        assertThat(catalogue.findById(id)).isEmpty();

        // But the admin GET-by-id resolves it (retired included) ...
        mockMvc.perform(get("/api/v1/admin/cities/{id}", id).with(admin("city-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.retired").value(true));

        // ... and the admin list (filtered to this class's country) contains it as retired.
        mockMvc.perform(get("/api/v1/admin/cities")
                        .param("size", "100")
                        .param("q", TEST_COUNTRY)
                        .with(admin("city-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + id + ")].retired").value(true));
    }

    @Test
    void restoreUnretires() throws Exception {
        CityCatalogue seeded = seed("Restore me", 0);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/cities/{id}/retire", id).with(admin("city-admin-restore")))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/admin/cities/{id}/restore", id).with(admin("city-admin-restore")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(true))
                .andExpect(jsonPath("$.retired").value(false))
                .andExpect(jsonPath("$.deletedAt").doesNotExist());

        assertThat(catalogue.findById(id)).isPresent(); // visible again
        assertThat(auditActionsFor(id)).contains(AuditAction.CITY_RESTORED);
    }

    @Test
    void restoreConflictsIfNameReTaken() throws Exception {
        CityCatalogue first = seed("Reused", 0);
        long firstId = first.getId();

        mockMvc.perform(post("/api/v1/admin/cities/{id}/retire", firstId).with(admin("city-admin-restore")))
                .andExpect(status().isOk());

        // A new active row grabs the same name while the first is retired.
        seed("Reused", 0);

        // Restoring the first would collide with the partial-unique index → 409.
        mockMvc.perform(post("/api/v1/admin/cities/{id}/restore", firstId).with(admin("city-admin-restore")))
                .andExpect(status().isConflict());
    }

    @Test
    void retireUnknownIdIs404() throws Exception {
        mockMvc.perform(post("/api/v1/admin/cities/{id}/retire", 999_999L).with(admin("city-admin-404")))
                .andExpect(status().isNotFound());
    }

    // --- Admin list filters + ordering ---

    @Test
    void adminListIncludesRetiredAndFiltersOnActive() throws Exception {
        CityCatalogue active = seed("List-Active", 0);
        CityCatalogue toRetire = seed("List-Retired", 0);
        mockMvc.perform(post("/api/v1/admin/cities/{id}/retire", toRetire.getId()).with(admin("city-admin-list")))
                .andExpect(status().isOk());

        // No active filter: BOTH the active and the retired throwaway row appear.
        mockMvc.perform(get("/api/v1/admin/cities")
                        .param("size", "100")
                        .param("q", TEST_COUNTRY)
                        .with(admin("city-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + active.getId() + ")]").exists())
                .andExpect(jsonPath("$.items[?(@.id == " + toRetire.getId() + ")].retired").value(true));

        // active=true excludes the retired one.
        mockMvc.perform(get("/api/v1/admin/cities")
                        .param("size", "100")
                        .param("q", TEST_COUNTRY)
                        .param("active", "true")
                        .with(admin("city-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + active.getId() + ")]").exists())
                .andExpect(jsonPath("$.items[?(@.id == " + toRetire.getId() + ")]").doesNotExist());
    }

    @Test
    void adminListRejectsUnknownSortProperty() throws Exception {
        mockMvc.perform(get("/api/v1/admin/cities")
                        .param("sort", "bogus,desc")
                        .with(admin("city-admin-sort")))
                .andExpect(status().isBadRequest());
    }
}
