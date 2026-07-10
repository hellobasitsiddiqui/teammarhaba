package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.membership.Membership;
import com.teammarhaba.backend.membership.MembershipRepository;
import com.teammarhaba.backend.membership.MembershipTier;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code GET /api/v1/events/{id}/entitlement} end to end (TM-476): the authoritative tier × event
 * entitlement the checkout screen (TM-479) consumes. Pins the HTTP contract — the JSON shape
 * ({@code decision}/{@code amountPence}/{@code reason}), the JIT membership enrolment, the 404 for a
 * hidden event, and the 401 for an anonymous caller. The exhaustive per-branch rule matrix lives in the
 * pure {@code EntitlementResolverTest}; this class proves the wiring (event load + membership read +
 * resolver) over a real Postgres.
 *
 * <p>The suite shares one database, so every case uses a unique caller uid and its own seeded event.
 */
@AutoConfigureMockMvc
class EntitlementIntegrationTest extends AbstractIntegrationTest {

    private static final int STANDARD_PRICE = 500; // £5 default
    private static final int PREMIUM_PRICE = 1500; // £15, admin-set premium price

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private MembershipRepository memberships;

    @Autowired
    private JdbcTemplate jdbc;

    // ------------------------------------------------------------------ PAY_PER_EVENT

    @Test
    void standardEventForNewPayPerEventCallerIsFreeAndJitEnrols() throws Exception {
        Event event = saveEvent(e -> {
            e.setPricePence(STANDARD_PRICE);
            e.setPremium(false);
        });
        var who = caller("uid-ent-free");

        // A brand-new caller: enrolled JIT onto PAY_PER_EVENT with the credit available → first is free.
        mockMvc.perform(get("/api/v1/events/" + event.getId() + "/entitlement").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.decision").value("FREE"))
                .andExpect(jsonPath("$.amountPence").value(0))
                .andExpect(jsonPath("$.reason").value("FIRST_EVENT_FREE"));

        // The membership was actually enrolled by the read (mirrors GET /me/membership behaviour).
        Long userId = users.findByFirebaseUid("uid-ent-free").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId)).isPresent();
    }

    @Test
    void premiumEventForPayPerEventWithCreditPaysPremiumAndKeepsCredit() throws Exception {
        Event event = saveEvent(e -> {
            e.setPricePence(PREMIUM_PRICE);
            e.setPremium(true);
        });
        var who = caller("uid-ent-premium");

        // THE load-bearing case: an available first-event credit does NOT make a premium event free.
        mockMvc.perform(get("/api/v1/events/" + event.getId() + "/entitlement").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.decision").value("PAY"))
                .andExpect(jsonPath("$.amountPence").value(PREMIUM_PRICE))
                .andExpect(jsonPath("$.reason").value("PAY_PREMIUM"));

        // A PAY decision consumes nothing — the first-event credit is still available afterwards.
        Long userId = users.findByFirebaseUid("uid-ent-premium").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId).orElseThrow().isFirstEventCreditUsed())
                .as("premium PAY must not consume the first-event credit")
                .isFalse();
    }

    @Test
    void standardEventAfterCreditUsedPaysStandardPrice() throws Exception {
        Event event = saveEvent(e -> {
            e.setPricePence(STANDARD_PRICE);
            e.setPremium(false);
        });
        // Seed a pay-per-event membership whose first-event credit is already spent (TM-477's job at
        // runtime; flipped directly here so we can exercise the credit-used branch over HTTP).
        seedMembership("uid-ent-used", MembershipTier.PAY_PER_EVENT, true);

        mockMvc.perform(get("/api/v1/events/" + event.getId() + "/entitlement").with(caller("uid-ent-used")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.decision").value("PAY"))
                .andExpect(jsonPath("$.amountPence").value(STANDARD_PRICE))
                .andExpect(jsonPath("$.reason").value("PAY_STANDARD"));
    }

    // ------------------------------------------------------------------ MONTHLY

    @Test
    void monthlyOnStandardIsIncluded() throws Exception {
        Event event = saveEvent(e -> {
            e.setPricePence(STANDARD_PRICE);
            e.setPremium(false);
        });
        seedMembership("uid-ent-monthly-std", MembershipTier.MONTHLY, false);

        mockMvc.perform(get("/api/v1/events/" + event.getId() + "/entitlement")
                        .with(caller("uid-ent-monthly-std")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.decision").value("INCLUDED"))
                .andExpect(jsonPath("$.amountPence").value(0))
                .andExpect(jsonPath("$.reason").value("INCLUDED_MONTHLY"));
    }

    @Test
    void monthlyOnPremiumPaysPremiumPrice() throws Exception {
        Event event = saveEvent(e -> {
            e.setPricePence(PREMIUM_PRICE);
            e.setPremium(true);
        });
        seedMembership("uid-ent-monthly-prem", MembershipTier.MONTHLY, false);

        mockMvc.perform(get("/api/v1/events/" + event.getId() + "/entitlement")
                        .with(caller("uid-ent-monthly-prem")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.decision").value("PAY"))
                .andExpect(jsonPath("$.amountPence").value(PREMIUM_PRICE))
                .andExpect(jsonPath("$.reason").value("PAY_PREMIUM"));
    }

    // ------------------------------------------------------------------ DIAMOND

    @Test
    void diamondIncludesEverythingIncludingPremium() throws Exception {
        Event premiumEvent = saveEvent(e -> {
            e.setPricePence(PREMIUM_PRICE);
            e.setPremium(true);
        });
        seedMembership("uid-ent-diamond", MembershipTier.DIAMOND, false);

        mockMvc.perform(get("/api/v1/events/" + premiumEvent.getId() + "/entitlement")
                        .with(caller("uid-ent-diamond")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.decision").value("INCLUDED"))
                .andExpect(jsonPath("$.amountPence").value(0))
                .andExpect(jsonPath("$.reason").value("INCLUDED_DIAMOND"));
    }

    // ------------------------------------------------------------------ 404 / 401

    @Test
    void hiddenEventIs404() throws Exception {
        // A not-yet-visible event (visibility window starts in the future) is hidden — a uniform 404,
        // exactly like the detail route, and indistinguishable from a missing id.
        Event hidden = saveEvent(e -> {
            e.setVisibilityStart(Instant.now().plus(1, ChronoUnit.DAYS));
            e.setVisibilityEnd(Instant.now().plus(3, ChronoUnit.DAYS));
        });

        mockMvc.perform(get("/api/v1/events/" + hidden.getId() + "/entitlement").with(caller("uid-ent-hidden")))
                .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/v1/events/999999999/entitlement").with(caller("uid-ent-missing")))
                .andExpect(status().isNotFound());
    }

    @Test
    void anonymousCallerGets401() throws Exception {
        Event event = saveEvent(e -> {});
        mockMvc.perform(get("/api/v1/events/" + event.getId() + "/entitlement"))
                .andExpect(status().isUnauthorized());
    }

    // ------------------------------------------------------------------ fixtures

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long creatorId() {
        return users.save(new User("uid-ent-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now event starting in 2 days; {@code tweak} customises price/premium/window. */
    private Event saveEvent(Consumer<Event> tweak) {
        Instant now = Instant.now();
        Event event = new Event(
                "Entitlement " + UUID.randomUUID(),
                "Come along!",
                "Marhaba Cafe",
                "Europe/London",
                now.plus(2, ChronoUnit.DAYS),
                now.minus(1, ChronoUnit.HOURS),
                now.plus(7, ChronoUnit.DAYS),
                creatorId(),
                now);
        tweak.accept(event);
        return events.save(event);
    }

    /**
     * Seed an account + a membership at {@code tier} for {@code uid}. When {@code creditUsed}, flips the
     * first-event credit to spent directly in the DB — there is no public mutator for it in this slice
     * (checkout, TM-477, owns the runtime consume), so a native update is the only way to reach the
     * credit-used branch over HTTP.
     */
    private void seedMembership(String uid, MembershipTier tier, boolean creditUsed) {
        Long userId = users.save(new User(uid, uid + "@example.com", "Member")).getId();
        Membership membership = new Membership(userId, Instant.now());
        if (tier != MembershipTier.PAY_PER_EVENT) {
            membership.changeTier(tier, Instant.now());
        }
        memberships.save(membership);
        if (creditUsed) {
            jdbc.update("update membership set first_event_credit_used = true where user_id = ?", userId);
        }
    }
}
