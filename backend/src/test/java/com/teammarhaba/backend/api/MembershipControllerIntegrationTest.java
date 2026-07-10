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
import com.teammarhaba.backend.membership.MembershipTier;
import com.teammarhaba.backend.membership.Subscription;
import com.teammarhaba.backend.membership.SubscriptionRepository;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code /api/v1/me/membership} (TM-474, payment-gated by TM-620): an authenticated caller reads their
 * membership — enrolled just-in-time onto {@code PAY_PER_EVENT} on first read — and self-switches
 * tiers; an anonymous caller gets the uniform {@code 401}. Since TM-620 switching INTO a paid tier
 * requires an active subscription covering it (a {@code 402} without one — the old free-upgrade
 * shortcut is gone), and leaving a paid tier while the subscription still renews is a {@code 409}
 * pointing at cancel; the tests seed {@code subscriptions} rows directly to exercise both sides of the
 * gate. The authenticated case injects a {@link VerifiedUser} principal directly (token verification is
 * exercised separately), mirroring {@link MeControllerIntegrationTest}.
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

    @Autowired
    private SubscriptionRepository subscriptions;

    private static RequestPostProcessor caller(String uid, String email) {
        return authentication(new UsernamePasswordAuthenticationToken(new VerifiedUser(uid, email), null, List.of()));
    }

    /** Seed an ACTIVE subscription for {@code uid}'s account — the TM-620 key that unlocks a paid tier. */
    private Subscription seedActiveSubscription(String uid, MembershipTier tier) {
        Long userId = users.findByFirebaseUid(uid).orElseThrow().getId();
        return subscriptions.save(new Subscription(userId, tier, "revolut", "cust-it", Instant.now()));
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
    void switchIntoPaidTierWithoutSubscriptionIs402() throws Exception {
        // TM-620: the free-upgrade shortcut is GONE — a paid tier without an active subscription is a
        // 402 Payment Required, and nothing changes on the membership row.
        var who = caller("uid-mem-gated", "leo@example.com");
        for (String tier : List.of("MONTHLY", "DIAMOND")) {
            switchTier(who, tier, org.springframework.http.HttpStatus.PAYMENT_REQUIRED);
        }
        Long userId = users.findByFirebaseUid("uid-mem-gated").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId).orElseThrow().getTier().name())
                .isEqualTo("PAY_PER_EVENT");
    }

    @Test
    void switchIntoPaidTierWithActiveSubscriptionPersistsAndReturnsIt() throws Exception {
        var who = caller("uid-mem-switch", "leo2@example.com");
        // Enrol the account first (GET), then seed the subscription the switch requires (TM-620).
        mockMvc.perform(get("/api/v1/me/membership").with(who)).andExpect(status().isOk());
        seedActiveSubscription("uid-mem-switch", MembershipTier.MONTHLY);

        mockMvc.perform(post("/api/v1/me/membership/tier")
                        .with(who)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"tier\":\"MONTHLY\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.tier").value("MONTHLY"))
                .andExpect(jsonPath("$.firstEventCreditAvailable").value(true));

        Long userId = users.findByFirebaseUid("uid-mem-switch").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId).orElseThrow().getTier().name())
                .isEqualTo("MONTHLY");

        // The MONTHLY subscription does NOT unlock DIAMOND (tier must match exactly).
        switchTier(who, "DIAMOND", org.springframework.http.HttpStatus.PAYMENT_REQUIRED);

        // And dropping to the free base while the subscription still renews is a 409 (cancel first).
        switchTier(who, "PAY_PER_EVENT", org.springframework.http.HttpStatus.CONFLICT);

        // A fresh GET still reads MONTHLY back from the database.
        mockMvc.perform(get("/api/v1/me/membership").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.tier").value("MONTHLY"));
    }

    @Test
    void switchDownIsAllowedOnceTheSubscriptionIsCanceled() throws Exception {
        var who = caller("uid-mem-cancel-down", "mira@example.com");
        mockMvc.perform(get("/api/v1/me/membership").with(who)).andExpect(status().isOk());
        Subscription subscription = seedActiveSubscription("uid-mem-cancel-down", MembershipTier.MONTHLY);
        switchTier(who, "MONTHLY", org.springframework.http.HttpStatus.OK);

        // Cancel stops renewals — the free base becomes reachable again (the paid access itself runs to
        // the period end server-side; switching down early is the caller's choice).
        subscription.cancelAtPeriodEnd(Instant.now());
        subscriptions.save(subscription);
        switchTier(who, "PAY_PER_EVENT", org.springframework.http.HttpStatus.OK);

        Long userId = users.findByFirebaseUid("uid-mem-cancel-down").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId).orElseThrow().getTier().name())
                .isEqualTo("PAY_PER_EVENT");
    }

    @Test
    void switchTierWorksBeforeAnyGet() throws Exception {
        // A switch before ever reading /membership still works — the endpoint enrols first, then applies
        // the TM-620 gate: without a subscription the paid switch is a 402 (the enrol itself succeeded).
        var who = caller("uid-mem-switch-first", "nyx@example.com");
        switchTier(who, "DIAMOND", org.springframework.http.HttpStatus.PAYMENT_REQUIRED);

        Long userId = users.findByFirebaseUid("uid-mem-switch-first").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId).orElseThrow().getTier().name())
                .isEqualTo("PAY_PER_EVENT");
    }

    @Test
    void switchTierRecordsMembershipTierChangedAudit() throws Exception {
        var who = caller("uid-mem-audit", "rumi@example.com");

        // Enrol + seed the covering subscription (TM-620), then the real change is audited.
        mockMvc.perform(get("/api/v1/me/membership").with(who)).andExpect(status().isOk());
        seedActiveSubscription("uid-mem-audit", MembershipTier.MONTHLY);
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
