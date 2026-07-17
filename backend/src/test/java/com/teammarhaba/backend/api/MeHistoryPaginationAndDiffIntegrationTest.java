package com.teammarhaba.backend.api;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * P2 characterization tests (TM-738 coverage audit, profile surface) for {@code GET /api/v1/me/history}
 * — the two edge seams the existing {@link MeHistoryIntegrationTest} leaves uncovered:
 *
 * <ul>
 *   <li><b>patchMeAuditsOnlyChangedFields</b> — a single PATCH that carries BOTH a genuinely-changed
 *       field and a field set to its CURRENT value must record ONLY the changed field in the audit
 *       diff. {@code MeHistoryIntegrationTest} pins the all-changed case and the all-no-op case, but
 *       never the MIXED case in one request. This proves {@link com.teammarhaba.backend.user.UserService#updateProfile}'s
 *       per-field {@code !Objects.equals(old, new)} guard (not just the whole-request no-op short-circuit).</li>
 *   <li><b>getMeHistoryPaginationSortAllowList</b> — the endpoint wires its OWN sort allow-list
 *       ({@code HISTORY_SORTABLE = {createdAt, id}}) and a newest-first default via
 *       {@link com.teammarhaba.backend.common.PageRequests}. A sort on a property OUTSIDE that list must
 *       be a uniform {@code 400} (never leaked to Spring Data → a 500 / schema leak), the allow-listed
 *       properties must be accepted, and {@code page}/{@code size} must page. {@code PageRequestsTest}
 *       covers the helper generically; this pins the CONTROLLER's specific allow-list wiring end-to-end.</li>
 * </ul>
 *
 * These assert existing behaviour → they pass green with no source change.
 */
@AutoConfigureMockMvc
class MeHistoryPaginationAndDiffIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    /** Convenience: PATCH /me with a raw JSON body as {@code who}, expecting 200. */
    private void patchMe(RequestPostProcessor who, String json) throws Exception {
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(json))
                .andExpect(status().isOk());
    }

    // ---- patchMeAuditsOnlyChangedFields ---------------------------------------------------------

    @Test
    void aPatchTouchingOneChangedAndOneUnchangedFieldAuditsOnlyTheChangedOne() throws Exception {
        var who = caller("uid-diff", "diff@example.com");

        // Seed: set firstName + city.
        patchMe(who, "{\"firstName\":\"Ada\",\"city\":\"London\"}");

        // Now PATCH BOTH fields in one request, but only city actually changes — firstName is re-sent at
        // its CURRENT value. The mixed request is the gap: only the changed field must be in the diff.
        patchMe(who, "{\"firstName\":\"Ada\",\"city\":\"Karachi\"}");

        mockMvc.perform(get("/api/v1/me/history").with(who))
                .andExpect(status().isOk())
                // Two entries: the seed, then the mixed edit — NOT a third for the unchanged firstName.
                .andExpect(jsonPath("$.items.length()").value(2))
                // The newest entry records EXACTLY ONE change (city), not two — the unchanged firstName
                // was filtered out by the per-field equality guard, not just left out of the response.
                .andExpect(jsonPath("$.items[0].metadata.changes.length()").value(1))
                .andExpect(jsonPath("$.items[0].metadata.changes[0].field").value("city"))
                .andExpect(jsonPath("$.items[0].metadata.changes[0].old").value("London"))
                .andExpect(jsonPath("$.items[0].metadata.changes[0].new").value("Karachi"));
    }

    // ---- getMeHistoryPaginationSortAllowList ----------------------------------------------------

    @Test
    void historyRejectsASortOutsideTheEndpointAllowListWith400() throws Exception {
        var who = caller("uid-badsort", "badsort@example.com");
        patchMe(who, "{\"city\":\"Sharjah\"}");

        // `email` is a real user column but NOT in the /me/history allow-list ({createdAt, id}); the
        // controller must 400 it rather than pass it through to Spring Data (which would 500 / leak schema).
        mockMvc.perform(get("/api/v1/me/history").param("sort", "email").with(who))
                .andExpect(status().isBadRequest());
    }

    @Test
    void historyAcceptsTheAllowListedSortProperties() throws Exception {
        var who = caller("uid-goodsort", "goodsort@example.com");
        patchMe(who, "{\"city\":\"Sharjah\"}");

        // Both allow-listed properties, in both directions, are accepted (200) — the timeline is sortable
        // by time and identity, the two the endpoint opts in.
        for (String sort : new String[] {"createdAt,desc", "createdAt,asc", "id,desc", "id,asc"}) {
            mockMvc.perform(get("/api/v1/me/history").param("sort", sort).with(who))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.items.length()").value(1));
        }
    }

    @Test
    void historyPaginatesAcrossThreeEditsWithPageAndSize() throws Exception {
        var who = caller("uid-page", "page@example.com");

        // Three distinct edits → three PROFILE_UPDATED entries, recorded oldest→newest.
        patchMe(who, "{\"city\":\"Karachi\"}");
        patchMe(who, "{\"city\":\"Sharjah\"}");
        patchMe(who, "{\"city\":\"Milton Keynes\"}");

        // Page 0, size 2 → the two newest (default sort is createdAt DESC): Milton Keynes then Sharjah.
        mockMvc.perform(get("/api/v1/me/history").param("page", "0").param("size", "2").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(2))
                .andExpect(jsonPath("$.items[0].metadata.changes[0].new").value("Milton Keynes"))
                .andExpect(jsonPath("$.items[1].metadata.changes[0].new").value("Sharjah"));

        // Page 1, size 2 → the remaining oldest entry: Karachi.
        mockMvc.perform(get("/api/v1/me/history").param("page", "1").param("size", "2").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1))
                .andExpect(jsonPath("$.items[0].metadata.changes[0].new").value("Karachi"));
    }
}
