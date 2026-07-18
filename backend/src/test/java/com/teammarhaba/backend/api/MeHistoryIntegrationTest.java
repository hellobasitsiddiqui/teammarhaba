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
 * Profile-change history (TM-185): each profile mutation records a {@code PROFILE_UPDATED} audit row
 * carrying the field-level {@code old → new} diff, and {@code GET /api/v1/me/history} reads the
 * caller's own changes newest-first. A user only ever sees their own history.
 */
@AutoConfigureMockMvc
class MeHistoryIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    @Test
    void recordsPerFieldDiffsAndReadsThemNewestFirst() throws Exception {
        var who = caller("uid-history", "ada@example.com");

        // First edit: set firstName + city (both from empty).
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Ada\",\"city\":\"London\"}"))
                .andExpect(status().isOk());

        // Second edit: change city + add age — proves old→new (London→Karachi) and a null→value diff.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"Karachi\",\"age\":30}"))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/me/history").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(2))
                // Newest first: the city→Karachi + age edit.
                .andExpect(jsonPath("$.items[0].action").value("PROFILE_UPDATED"))
                .andExpect(jsonPath("$.items[0].metadata.source").value("self"))
                .andExpect(jsonPath("$.items[0].metadata.targetUid").value("uid-history"))
                .andExpect(jsonPath("$.items[0].metadata.changes[0].field").value("city"))
                .andExpect(jsonPath("$.items[0].metadata.changes[0].old").value("London"))
                .andExpect(jsonPath("$.items[0].metadata.changes[0].new").value("Karachi"))
                .andExpect(jsonPath("$.items[0].metadata.changes[1].field").value("age"))
                .andExpect(jsonPath("$.items[0].metadata.changes[1].new").value(30))
                // Oldest: the initial firstName + city set.
                .andExpect(jsonPath("$.items[1].metadata.changes[0].field").value("firstName"))
                .andExpect(jsonPath("$.items[1].metadata.changes[0].new").value("Ada"));
    }

    @Test
    void noOpPatchOfTheSameValueRecordsNothing() throws Exception {
        var who = caller("uid-noop", "grace@example.com");

        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"Sharjah\"}"))
                .andExpect(status().isOk());
        // Patching the same value again changes nothing → no second history entry.
        mockMvc.perform(patch("/api/v1/me")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"Sharjah\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/me/history").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(1));
    }

    @Test
    void aUserOnlySeesTheirOwnHistory() throws Exception {
        mockMvc.perform(patch("/api/v1/me")
                        .with(caller("uid-alice", "alice@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"city\":\"London\"}"))
                .andExpect(status().isOk());

        // Bob has made no edits — his history is empty, and he can't see Alice's.
        mockMvc.perform(get("/api/v1/me/history").with(caller("uid-bob", "bob@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(0));
    }

    @Test
    void rejectsAnonymousWith401() throws Exception {
        mockMvc.perform(get("/api/v1/me/history")).andExpect(status().isUnauthorized());
    }
}
