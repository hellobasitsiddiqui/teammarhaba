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

    @Test
    void nonAdminForbiddenOnPatchDeactivateReactivate() throws Exception {
        // nonAdminGetsUniform403 above covers GET/POST-create; this pins the remaining mutating verbs
        // under the class-level @PreAuthorize("hasRole('ADMIN')"). A non-admin must be denied on the
        // edit and the lifecycle sub-actions too — and the gate fires BEFORE existence is checked, so
        // a real venue id yields a uniform 403, never a 404 that would leak whether the id exists.
        Venue seeded = seedVenue("RBAC lifecycle", true);
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/venues/{id}", id)
                        .with(regularUser("venues-plain-user"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"hijack\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.title").value("Forbidden"));

        mockMvc.perform(post("/api/v1/admin/venues/{id}/deactivate", id).with(regularUser("venues-plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.title").value("Forbidden"));

        mockMvc.perform(post("/api/v1/admin/venues/{id}/reactivate", id).with(regularUser("venues-plain-user")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.title").value("Forbidden"));

        // The denied edit never landed — the venue is unchanged and still active.
        Venue reloaded = venues.findById(id).orElseThrow();
        assertThat(reloaded.getName()).isEqualTo("RBAC lifecycle");
        assertThat(reloaded.isActive()).isTrue();
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
    void createRejectsMalformedPhotoPath() throws Exception {
        // photoPath must be a storage object path shaped like `venue-images/{venueId}` — the
        // @Pattern(regexp = "venue-images/[A-Za-z0-9._-]+") on CreateVenueRequest. A path that
        // escapes that prefix (a traversal-shaped "../../secrets/leak" here) must be rejected at the
        // validation boundary with a field-scoped RFC-7807 error, never persisted.
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-photo"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace(
                                "\"indoorOutdoor\": \"INDOOR\"",
                                "\"indoorOutdoor\": \"INDOOR\", \"photoPath\": \"../../secrets/leak\"")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'photoPath')]").exists());
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

    // TM-738 P1 (venues) — create-body validation negatives that today are only asserted for `name`
    // (createRejectsBlankName above) and the coordinate pair. These pin the remaining
    // CreateVenueRequest constraints — @NotBlank addressLine, the @Size column-mirroring caps, and the
    // @DecimalMin/Max/@Min numeric bounds — so a body the DB would reject (or an out-of-range value)
    // is stopped at the validation boundary with a field-scoped RFC-7807 error, never persisted.
    // Characterization: the annotations already enforce these, so these PASS.

    @Test
    void createRejectsBlankAddressLine() throws Exception {
        // addressLine is @NotBlank (required, like name). A present-but-empty address is never
        // meaningful — it must be a field-scoped 400, the same shape as createRejectsBlankName.
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-addr"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("12 High Street, London E1 6AA", "")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'addressLine')]").exists());
    }

    @Test
    void createRejectsFieldOverCap() throws Exception {
        // Per-field @Size caps mirror the V41 columns (name VARCHAR(160), city VARCHAR(120)). A value
        // over the cap must be rejected at bean-validation BEFORE it can hit the DB, with a
        // field-scoped RFC-7807 error naming the offending field — proving the app catches it, not
        // that a database constraint later blows up as an opaque 500.
        String cityOverCap = "x".repeat(121); // city @Size(max = 120)
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-cap"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"city\": \"London\"", "\"city\": \"" + cityOverCap + "\"")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'city')]").exists());

        // name @Size(max = 160) is the other required-field cap — same rejection shape.
        String nameOverCap = "y".repeat(161);
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-cap"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("Marhaba Community Hall", nameOverCap)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'name')]").exists());
    }

    @Test
    void createRejectsOutOfRangeCoordinatesAndCapacity() throws Exception {
        // The numeric-bound constraints: latitude @DecimalMin("-90.0")/@DecimalMax("90.0"),
        // longitude @DecimalMin("-180.0")/@DecimalMax("180.0"), capacity @Min(1). An out-of-range
        // value is a field-scoped 400 — a coordinate that can't be a real geo point, or a capacity
        // below one, must never persist.

        // latitude past the 90° pole (with a valid longitude so the pair rule is satisfied and the
        // range check is what fires).
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-range"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"capacity\": 120", "\"latitude\": 90.5, \"longitude\": -0.12")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'latitude')]").exists());

        // longitude past the 180° meridian.
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-range"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"capacity\": 120", "\"latitude\": 51.5, \"longitude\": 180.5")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'longitude')]").exists());

        // capacity below 1 — @Min(1). A place that can seat nobody is not a usable venue.
        mockMvc.perform(post("/api/v1/admin/venues")
                        .with(admin("venues-admin-range"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(VALID_BODY.replace("\"capacity\": 120", "\"capacity\": 0")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors[?(@.field == 'capacity')]").exists());
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

    // TM-738 P1 (venues) — UpdateVenueRequest behaviours the existing edit tests don't pin: the
    // photoPath round-trip (the console PATCHes the uploaded object path after a create), the
    // present-but-blank guards on the required fields, and the "single coordinate edge is allowed on
    // PATCH" rule (create demands both edges; PATCH may set just one, since the row may already hold
    // its partner). Characterization: the DTO + service already do this, so these PASS.

    @Test
    void updatePersistsAndReturnsPhotoPath() throws Exception {
        // A venue photo is uploaded to Storage first, then its object path is PATCHed onto the row
        // (the house avatar/image pattern — the id can't exist before creation). A well-formed
        // `venue-images/{id}` path must be accepted, persisted, and echoed back in the 200 body.
        Venue seeded = seedVenue("Photo target", true);
        long id = seeded.getId();
        String photoPath = "venue-images/" + id;

        mockMvc.perform(patch("/api/v1/admin/venues/{id}", id)
                        .with(admin("venues-admin-photo-patch"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"photoPath\":\"" + photoPath + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.photoPath").value(photoPath));

        // The path really landed on the row (not just reflected in the response).
        assertThat(venues.findById(id).orElseThrow().getPhotoPath()).isEqualTo(photoPath);
        assertThat(auditActionsFor(id)).contains(AuditAction.VENUE_UPDATED);
    }

    @Test
    void updateRejectsBlankNameAndAddressLine() throws Exception {
        // On PATCH, name/addressLine are optional (null = leave unchanged) but must NOT be set to a
        // present-but-blank value — the @AssertTrue isNameUsable()/isAddressLineUsable() guards. A
        // whitespace-only value must be a validation 400, never a blank required field written to the
        // row (which would then violate the NOT NULL/meaningful contract everywhere the venue is used).
        Venue seeded = seedVenue("Keep the name", true);
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/venues/{id}", id)
                        .with(admin("venues-admin-blank-patch"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"   \"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));

        mockMvc.perform(patch("/api/v1/admin/venues/{id}", id)
                        .with(admin("venues-admin-blank-patch"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"addressLine\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"));

        // Neither doomed PATCH landed — the venue's original name survives.
        assertThat(venues.findById(id).orElseThrow().getName()).isEqualTo("Keep the name");
    }

    @Test
    void updateAllowsSingleCoordinateEdge() throws Exception {
        // Unlike create (which demands both latitude AND longitude), a PATCH may carry just one edge:
        // the row may already hold its partner, so the coordinate-pair rule is enforced only when the
        // patch itself carries both. Patch a lone longitude and it must persist without a 400.
        Venue seeded = seedVenue("Coordinate edit", true);
        long id = seeded.getId();

        mockMvc.perform(patch("/api/v1/admin/venues/{id}", id)
                        .with(admin("venues-admin-coord-patch"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"longitude\":-0.09}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.longitude").value(-0.09));

        assertThat(venues.findById(id).orElseThrow().getLongitude()).isEqualTo(-0.09);
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

    @Test
    void reactivateOnAlreadyActiveIsIdempotentNoReAudit() throws Exception {
        // TM-738 P1 (venues): reactivate mirrors deactivate's idempotency. deactivateKeepsTheRecord…
        // above pins the deactivate side (a repeat deactivate does not re-audit); this pins the
        // reactivate side directly on an ALREADY-active venue. VenueAdminService.reactivate returns
        // the venue unchanged and — because it never transitions — records NO VENUE_REACTIVATED audit
        // row. If that early-return guard regressed, a no-op reactivate would spam the audit trail.
        Venue seeded = seedVenue("Already active", true);
        long id = seeded.getId();

        mockMvc.perform(post("/api/v1/admin/venues/{id}/reactivate", id).with(admin("venues-admin-react")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(true));

        // No transition happened, so nothing was audited.
        assertThat(auditActionsFor(id)).doesNotContain(AuditAction.VENUE_REACTIVATED);
        assertThat(venues.findById(id).orElseThrow().isActive()).isTrue();

        // A second reactivate is likewise a clean no-op — still no audit row.
        mockMvc.perform(post("/api/v1/admin/venues/{id}/reactivate", id).with(admin("venues-admin-react")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.active").value(true));
        assertThat(auditActionsFor(id)).doesNotContain(AuditAction.VENUE_REACTIVATED);
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
