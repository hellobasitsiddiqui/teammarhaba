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
import com.teammarhaba.backend.event.Venue;
import com.teammarhaba.backend.event.VenueRepository;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The admin venues API (TM-519) end-to-end through the real security chain + Postgres:
 *
 * <ul>
 *   <li><b>RBAC, the TM-111 pattern</b> — anon → uniform 401, USER → uniform 403, and a missing id
 *       → plain 404 (no existence leak).</li>
 *   <li><b>Validation</b> — name/address required, caps mirror the V40 columns, coordinate pair must
 *       be complete, storage-path-shaped photo path.</li>
 *   <li><b>Create</b> — audited (VENUE_CREATED), DB-authoritative createdAt carried in the 201 body.</li>
 *   <li><b>Edit</b> — partial PATCH; a no-op PATCH neither touches nor audits.</li>
 *   <li><b>Deactivate / reactivate</b> — the record survives (deactivate ≠ delete), idempotent, and
 *       never double-audits.</li>
 *   <li><b>List / search</b> — full inventory, name/city search, and the active-only picker filter.</li>
 * </ul>
 *
 * <p>The suite shares one database across test classes, so assertions use contains/filtering on this
 * class's own rows rather than exact table contents.
 */
@AutoConfigureMockMvc
class VenueAdminControllerIntegrationTest extends AbstractIntegrationTest {

    private static final String VALID_BODY =
            """
            {
              "name": "Marhaba Community Hall",
              "addressLine": "12 High Street, London E1 6AA",
              "city": "London",
              "capacity": 120,
              "indoorOutdoor": "INDOOR"
            }
            """;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private VenueRepository venues;

    @Autowired
    private UserRepository users;

    @Autowired
    private AuditService audit;

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

    /** Seed a venue directly through the repository (needs a creator row for the FK). */
    private Venue seedVenue(String name, boolean active) {
        Long creatorId = users.findByFirebaseUid("venue-admin-seed-uid")
                .orElseGet(() -> users.saveAndFlush(new User("venue-admin-seed-uid", "vseed@example.com", "Seeder")))
                .getId();
        Venue venue = new Venue(name, name + " address", creatorId, Instant.now());
        venue.setCity("London");
        venue.setActive(active);
        return venues.saveAndFlush(venue);
    }

    private List<AuditAction> auditActionsFor(long venueId) {
        return audit.search(null, "Venue", String.valueOf(venueId), PageRequest.of(0, 20)).getContent().stream()
                .map(AuditEvent::getAction)
                .toList();
    }

    // --- RBAC: the TM-111 401/403/404 pattern ---

    @Test
    void anonymousGetsUniform401() throws Exception {
        mockMvc.perform(get("/api/v1/admin/venues"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.title").value("Unauthorized"));
    }

    @Test
    void nonAdminGetsUniform403() throws Exception {
        mockMvc.perform(get("/api/v1/admin/venues").with(regularUser("venues-plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.title").value("Forbidden"));

        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(regularUser("venues-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY))
                .andExpect(status().isForbidden());
    }

    @Test
    void missingVenueIs404NotLeaking() throws Exception {
        mockMvc.perform(get("/api/v1/admin/venues/{id}", 999_999L).with(admin("venues-admin-404")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.title").value("Resource not found"));

        mockMvc.perform(post("/api/v1/admin/venues/{id}/deactivate", 999_999L).with(admin("venues-admin-404")))
                .andExpect(status().isNotFound());
    }

    // --- Create ---

    @Test
    void adminCreatesVenueAuditedWithDbTimestamp() throws Exception {
        String body = mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-create"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").isNumber())
                .andExpect(jsonPath("$.name").value("Marhaba Community Hall"))
                .andExpect(jsonPath("$.addressLine").value("12 High Street, London E1 6AA"))
                .andExpect(jsonPath("$.city").value("London"))
                .andExpect(jsonPath("$.capacity").value(120))
                .andExpect(jsonPath("$.indoorOutdoor").value("INDOOR"))
                .andExpect(jsonPath("$.active").value(true))
                // created_at is DB-authoritative; the 201 body must carry the real value, not null
                .andExpect(jsonPath("$.createdAt").isNotEmpty())
                .andExpect(jsonPath("$.createdBy").isNumber())
                .andReturn()
                .getResponse()
                .getContentAsString();
        long id = JsonPath.parse(body).<Number>read("$.id").longValue();

        Venue saved = venues.findById(id).orElseThrow();
        assertThat(saved.getName()).isEqualTo("Marhaba Community Hall");
        assertThat(saved.isActive()).isTrue();
        assertThat(auditActionsFor(id)).contains(AuditAction.VENUE_CREATED);
    }

    // --- Validation ---

    @Test
    void createRejectsBlankName() throws Exception {
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("Marhaba Community Hall", "")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'name')]").exists());
    }

    @Test
    void createRejectsHalfACoordinatePair() throws Exception {
        // latitude without longitude can't place a point on a map — the @AssertTrue pair rule.
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-val"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"capacity\": 120", "\"latitude\": 51.5")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));
    }

    @Test
    void createAcceptsAFullCoordinatePair() throws Exception {
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-geo"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"capacity\": 120", "\"latitude\": 51.5, \"longitude\": -0.12")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.latitude").value(51.5))
                .andExpect(jsonPath("$.longitude").value(-0.12));
    }

    // --- Edit (PATCH) ---

    @Test
    void adminEditsVenueAuditedAndPropagates() throws Exception {
        Venue seeded = seedVenue("Edit me", true);
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/venues/{id}", id)
                        .with(admin("venues-admin-edit"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Edited hall\",\"parking\":\"Free after 6pm\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("Edited hall"))
                .andExpect(jsonPath("$.parking").value("Free after 6pm"))
                // untouched fields survive a partial edit
                .andExpect(jsonPath("$.addressLine").value("Edit me address"));

        Venue reloaded = venues.findById(id).orElseThrow();
        assertThat(reloaded.getName()).isEqualTo("Edited hall");
        assertThat(auditActionsFor(id)).contains(AuditAction.VENUE_UPDATED);
    }

    @Test
    void noOpPatchNeitherAuditsNorTouches() throws Exception {
        Venue seeded = seedVenue("No-op", true);
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/venues/{id}", id)
                        .with(admin("venues-admin-noop"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("No-op"));

        assertThat(auditActionsFor(id)).doesNotContain(AuditAction.VENUE_UPDATED);
    }

    // --- Deactivate / reactivate ---

    @Test
    void deactivateKeepsTheRecordAndIsIdempotent() throws Exception {
        Venue seeded = seedVenue("Deactivate me", true);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/venues/{id}/deactivate", id).with(admin("venues-admin-deact")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(false));

        // deactivate is NOT delete: the row survives, readable, active=false
        Venue reloaded = venues.findById(id).orElseThrow();
        assertThat(reloaded.isActive()).isFalse();
        assertThat(reloaded.getDeletedAt()).isNull();
        assertThat(auditActionsFor(id)).contains(AuditAction.VENUE_DEACTIVATED);

        // idempotent: a second deactivate succeeds but does not re-audit
        mockMvc.perform(post("/api/v1/admin/venues/{id}/deactivate", id).with(admin("venues-admin-deact")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(false));
        assertThat(auditActionsFor(id)).containsOnlyOnce(AuditAction.VENUE_DEACTIVATED);

        // reactivate brings it back into the picker
        mockMvc.perform(post("/api/v1/admin/venues/{id}/reactivate", id).with(admin("venues-admin-deact")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(true));
        assertThat(venues.findById(id).orElseThrow().isActive()).isTrue();
        assertThat(auditActionsFor(id)).contains(AuditAction.VENUE_REACTIVATED);
    }

    // --- List / search ---

    @Test
    void listSearchesByNameAndFiltersActiveOnly() throws Exception {
        Venue active = seedVenue("Riverside Pavilion ZZ", true);
        Venue inactive = seedVenue("Riverside Pavilion ZZ (old)", false);

        // Full inventory (no active filter): both the active and the deactivated venue appear.
        mockMvc.perform(get("/api/v1/admin/venues")
                        .param("size", "100")
                        .param("q", "Riverside Pavilion ZZ")
                        .with(admin("venues-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + active.getId() + ")].name").value("Riverside Pavilion ZZ"))
                .andExpect(jsonPath("$.items[?(@.id == " + inactive.getId() + ")].active").value(false));

        // Active-only (the picker filter): the deactivated venue drops out.
        mockMvc.perform(get("/api/v1/admin/venues")
                        .param("size", "100")
                        .param("q", "Riverside Pavilion ZZ")
                        .param("active", "true")
                        .with(admin("venues-admin-list")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[?(@.id == " + active.getId() + ")]").exists())
                .andExpect(jsonPath("$.items[?(@.id == " + inactive.getId() + ")]").doesNotExist());
    }

    @Test
    void listRejectsUnknownSortProperty() throws Exception {
        mockMvc.perform(get("/api/v1/admin/venues").param("sort", "deletedAt").with(admin("venues-admin-sort")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Invalid request"));
    }
}
