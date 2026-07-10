package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.audit.AuditAction;
import com.teammarhaba.backend.audit.AuditEvent;
import com.teammarhaba.backend.audit.AuditRepository;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.membership.MembershipRepository;
import com.teammarhaba.backend.user.UserRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code /api/v1/me/membership} (TM-474): an authenticated caller reads their membership — enrolled
 * just-in-time onto {@code PAY_PER_EVENT} on first read — and self-switches tiers; an anonymous caller
 * gets the uniform {@code 401}. The authenticated case injects a {@link VerifiedUser} principal directly
 * (token verification is exercised separately), mirroring {@link MeControllerIntegrationTest}.
 */
@AutoConfigureMockMvc
class MembershipControllerIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private MembershipRepository memberships;

    @Autowired
    private UserRepository users;

    @Autowired
    private AuditRepository audit;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    /** POST /me/membership/tier {tier} — the self-serve switch body helper. */
    private void switchTier(RequestPostProcessor who, String tier, org.springframework.http.HttpStatus expected)
            throws Exception {
        mockMvc.perform(post("/api/v1/me/membership/tier")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tier\":\"" + tier + "\"}"))
                .andExpect(status().is(expected.value()));
    }

    @Test
    void getJitEnrolsOntoPayPerEventWithFirstEventCreditAvailable() throws Exception {
        // First read of a brand-new account enrols a membership on the default tier, with the first-event
        // freebie still available (firstEventCreditAvailable = !firstEventCreditUsed).
        mockMvc.perform(get("/api/v1/me/membership").with(caller("uid-mem-new", "ada@example.com")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.tier").value("PAY_PER_EVENT"))
                .andExpect(jsonPath("$.firstEventCreditAvailable").value(true));

        // A row was actually persisted for the account (not just echoed back).
        Long userId = users.findByFirebaseUid("uid-mem-new").orElseThrow().getId();
        var saved = memberships.findByUserId(userId).orElseThrow();
        assertThat(saved.getTier().name()).isEqualTo("PAY_PER_EVENT");
        assertThat(saved.isFirstEventCreditUsed()).isFalse();
    }

    @Test
    void getReusesTheSameMembershipRowOnSecondCall() throws Exception {
        var who = caller("uid-mem-reuse", "grace@example.com");

        mockMvc.perform(get("/api/v1/me/membership").with(who)).andExpect(status().isOk());
        Long userId = users.findByFirebaseUid("uid-mem-reuse").orElseThrow().getId();
        Long firstId = memberships.findByUserId(userId).orElseThrow().getId();

        // Second read reuses the same row — no duplicate enrolment.
        mockMvc.perform(get("/api/v1/me/membership").with(who)).andExpect(status().isOk());

        assertThat(memberships.findByUserId(userId).orElseThrow().getId()).isEqualTo(firstId);
        assertThat(memberships.findAll().stream().filter(m -> m.getUserId().equals(userId)))
                .as("exactly one membership row exists for the account")
                .hasSize(1);
    }

    @Test
    void switchToEachTierPersistsAndReturnsIt() throws Exception {
        var who = caller("uid-mem-switch", "leo@example.com");

        // Enrol (defaults to PAY_PER_EVENT), then walk every tier: each switch returns and persists it.
        for (String tier : List.of("MONTHLY", "DIAMOND", "PAY_PER_EVENT")) {
            mockMvc.perform(post("/api/v1/me/membership/tier")
                            .with(who)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"tier\":\"" + tier + "\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.tier").value(tier))
                    .andExpect(jsonPath("$.firstEventCreditAvailable").value(true));

            Long userId = users.findByFirebaseUid("uid-mem-switch").orElseThrow().getId();
            assertThat(memberships.findByUserId(userId).orElseThrow().getTier().name())
                    .isEqualTo(tier);
        }

        // And a fresh GET reads the last tier back from the database.
        mockMvc.perform(get("/api/v1/me/membership").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.tier").value("PAY_PER_EVENT"));
    }

    @Test
    void switchTierWorksBeforeAnyGet() throws Exception {
        // A switch before ever reading /membership still works — the endpoint enrols first, then switches.
        var who = caller("uid-mem-switch-first", "nyx@example.com");
        switchTier(who, "DIAMOND", org.springframework.http.HttpStatus.OK);

        Long userId = users.findByFirebaseUid("uid-mem-switch-first").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId).orElseThrow().getTier().name())
                .isEqualTo("DIAMOND");
    }

    @Test
    void switchTierRecordsMembershipTierChangedAudit() throws Exception {
        var who = caller("uid-mem-audit", "rumi@example.com");

        // PAY_PER_EVENT (enrol default) -> MONTHLY is a real change, so it is audited.
        switchTier(who, "MONTHLY", org.springframework.http.HttpStatus.OK);

        List<AuditEvent> events = audit.findByActorUidOrderByCreatedAtDesc("uid-mem-audit").stream()
                .filter(e -> e.getAction() == AuditAction.MEMBERSHIP_TIER_CHANGED)
                .toList();
        assertThat(events).hasSize(1);
        AuditEvent event = events.get(0);
        assertThat(event.getTargetType()).isEqualTo("Membership");
        Long userId = users.findByFirebaseUid("uid-mem-audit").orElseThrow().getId();
        assertThat(event.getTargetId()).isEqualTo(String.valueOf(userId));
        assertThat(event.getMetadata()).containsEntry("from", "PAY_PER_EVENT").containsEntry("to", "MONTHLY");
    }

    @Test
    void switchToTheSameTierIsANoOpAndNotAudited() throws Exception {
        var who = caller("uid-mem-noop", "ibn@example.com");

        // Enrol on PAY_PER_EVENT, then "switch" to the tier already held — idempotent, still 200.
        mockMvc.perform(get("/api/v1/me/membership").with(who)).andExpect(status().isOk());
        switchTier(who, "PAY_PER_EVENT", org.springframework.http.HttpStatus.OK);

        assertThat(audit.findByActorUidOrderByCreatedAtDesc("uid-mem-noop").stream()
                        .filter(e -> e.getAction() == AuditAction.MEMBERSHIP_TIER_CHANGED))
                .as("a no-op switch to the current tier records no audit event")
                .isEmpty();
    }

    @Test
    void rejectsUnknownTierWith400() throws Exception {
        switchTier(
                caller("uid-mem-bad", "x@example.com"),
                "PLATINUM",
                org.springframework.http.HttpStatus.BAD_REQUEST);
    }

    @Test
    void rejectsMissingTierWith400() throws Exception {
        mockMvc.perform(post("/api/v1/me/membership/tier")
                        .with(caller("uid-mem-missing", "x@example.com"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsAnonymousWith401() throws Exception {
        mockMvc.perform(get("/api/v1/me/membership")).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/me/membership/tier")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tier\":\"MONTHLY\"}"))
                .andExpect(status().isUnauthorized());
    }
}
