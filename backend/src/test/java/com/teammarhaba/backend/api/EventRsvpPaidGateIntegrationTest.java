package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.AttendanceState;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventAttendance;
import com.teammarhaba.backend.event.EventAttendanceRepository;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.membership.Membership;
import com.teammarhaba.backend.membership.MembershipRepository;
import com.teammarhaba.backend.membership.MembershipTier;
import com.teammarhaba.backend.membership.Order;
import com.teammarhaba.backend.membership.OrderRepository;
import com.teammarhaba.backend.membership.OrderStatus;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The paid-event join gate over the direct verbs (TM-625), end to end with the server-side membership
 * flag ON (the shared test profile): {@code POST /events/{id}/rsvp} and {@code POST /events/{id}/claim}
 * must not let anyone free-join an event whose entitlement resolves to {@code PAY}. This was the
 * residual deploy blocker from the TM-623 adversarial re-verify — checkout's PAY branch was gated, but
 * these two verbs still landed any authenticated caller {@code GOING} on a premium/priced event with no
 * order and no payment.
 *
 * <p>Proves, over a real Postgres + MockMvc:
 *
 * <ul>
 *   <li>a {@code PAY} entitlement (premium event; or a priced standard event once the caller's
 *       first-event credit is spent) cannot be joined via RSVP or claim — {@code 402 Payment Required},
 *       no attendance row is written, the payment provider is never touched;</li>
 *   <li>{@code FREE} (a genuinely free event, or the first-event credit) and {@code INCLUDED} (tier
 *       covers it) still join directly, exactly as before;</li>
 *   <li>a paid-up member — settled ({@code CONFIRMED}) order, landed {@code WAITLISTED} by the payment
 *       webhook because the event was full — still claims a freed spot normally (the gate must never
 *       demand a second payment).</li>
 * </ul>
 *
 * <p>The flag-OFF behaviour (both verbs ungated — the paid feature does not exist) is proven by
 * {@code MembershipDisabledIntegrationTest}, which boots its own flag-off context.
 *
 * <p>The suite shares one database, so every case uses a unique caller uid and its own seeded event.
 */
@AutoConfigureMockMvc
class EventRsvpPaidGateIntegrationTest extends AbstractIntegrationTest {

    private static final int STANDARD_PRICE = 500; // £5 default
    private static final int PREMIUM_PRICE = 1500; // £15, admin-set premium price

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private EventAttendanceRepository attendance;

    @Autowired
    private UserRepository users;

    @Autowired
    private MembershipRepository memberships;

    @Autowired
    private OrderRepository orders;

    @Autowired
    private JdbcTemplate jdbc;

    // The payment seam, mocked — and expected to record ZERO interactions: the gate refuses the free
    // join outright, it never opens (or needs) a provider order. Matches CheckoutIntegrationTest's
    // override set so the cached application context is shared.
    @MockitoBean
    private PaymentProvider paymentProvider;

    // ------------------------------------------------------------------ PAY is not free-joinable

    @Test
    void rsvpOnAPremiumEventIsRefusedWithPaymentRequired() throws Exception {
        Event event = premiumEvent();
        Long userId = seedUser("uid-gate-rsvp-premium");

        // Any caller below Diamond resolves PAY on a premium event — the exact original exploit:
        // before TM-625 this request landed GOING with no order and no payment.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(caller("uid-gate-rsvp-premium")))
                .andExpect(status().isPaymentRequired())
                .andExpect(jsonPath("$.title").value("Payment required"))
                .andExpect(jsonPath("$.detail").value(containsString("checkout")));

        assertThat(attendanceCount(event.getId(), userId))
                .as("a refused paid join must write NO attendance row")
                .isZero();
        Mockito.verifyNoInteractions(paymentProvider); // refused outright — no provider order either
    }

    @Test
    void rsvpOnAPricedStandardEventWithTheCreditSpentIsRefused() throws Exception {
        // PAY also arises on a standard priced event once the pay-per-event caller's first-event
        // credit is gone — the £5 path must be just as un-free-joinable as premium.
        Event event = standardEvent();
        seedMembership("uid-gate-rsvp-standard", MembershipTier.PAY_PER_EVENT, true);
        Long userId = users.findByFirebaseUid("uid-gate-rsvp-standard").orElseThrow().getId();

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(caller("uid-gate-rsvp-standard")))
                .andExpect(status().isPaymentRequired());

        assertThat(attendanceCount(event.getId(), userId)).isZero();
        Mockito.verifyNoInteractions(paymentProvider);
    }

    @Test
    void claimOnAPremiumEventIsRefusedForAnUnpaidWaitlistedMember() throws Exception {
        Event event = premiumEvent();
        Long userId = seedUser("uid-gate-claim-premium");
        // Seed the waitlist row directly (legacy/pre-fix data — with the RSVP verb now gated, this is
        // how an unpaid waitlist entry on a paid event can still exist). Claim is a route into a GOING
        // spot, so promoting it for free would be the same money bypass through the side door.
        attendance.save(new EventAttendance(event.getId(), userId, AttendanceState.WAITLISTED));

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim").with(caller("uid-gate-claim-premium")))
                .andExpect(status().isPaymentRequired())
                .andExpect(jsonPath("$.detail").value(containsString("checkout")));

        assertThat(attendance
                        .findByEventIdAndUserId(event.getId(), userId)
                        .orElseThrow()
                        .getState())
                .as("a refused claim must leave the member exactly where they were")
                .isEqualTo(AttendanceState.WAITLISTED);
        Mockito.verifyNoInteractions(paymentProvider);
    }

    // ------------------------------------------------------------------ a settled order still claims

    @Test
    void paidUpWaitlistedMemberStillClaimsNormally() throws Exception {
        Event event = premiumEvent();
        Long userId = seedUser("uid-gate-claim-paid");
        // The paid flow can legitimately land WAITLISTED: checkout settled a CONFIRMED order, and the
        // payment webhook's RSVP hit a full event. When a spot frees, this member's claim must pass the
        // gate — their money already settled; demanding a second payment would break the paid path.
        orders.save(new Order(userId, event.getId(), PREMIUM_PRICE, OrderStatus.CONFIRMED, Instant.now()));
        attendance.save(new EventAttendance(event.getId(), userId, AttendanceState.WAITLISTED));

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim").with(caller("uid-gate-claim-paid")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
    }

    // ------------------------------------------------------------------ FREE / INCLUDED join normally

    @Test
    void genuinelyFreeEventStillRsvpsDirectly() throws Exception {
        // A £0 event resolves FREE for everyone — no charge stands in the way, the verb stays open.
        Event event = saveEvent(e -> e.setPricePence(0));

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(caller("uid-gate-free-event")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));

        // A genuinely free event (reason FREE_EVENT) consumes NOTHING (TM-629): only a FIRST_EVENT_FREE
        // landing spends the credit — the freebie is never wasted on an event that costs nothing anyway.
        Long userId = users.findByFirebaseUid("uid-gate-free-event").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId).orElseThrow().isFirstEventCreditUsed())
                .isFalse();
    }

    @Test
    void monthlyMemberStillRsvpsDirectlyOnAStandardEvent() throws Exception {
        // MONTHLY on a standard event resolves INCLUDED — the tier already covers it.
        Event event = standardEvent();
        seedMembership("uid-gate-monthly", MembershipTier.MONTHLY, false);

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(caller("uid-gate-monthly")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
    }

    @Test
    void firstEventCreditHolderRsvpsDirectlyAndTheCommitmentConsumesTheCredit() throws Exception {
        // A brand-new pay-per-event caller with the credit available resolves FREE on a standard event,
        // so the direct join proceeds — and the landing is a COMMITMENT, so it spends the one
        // first-event credit exactly as checkout does (TM-629). Pre-fix the verb only READ the
        // entitlement: the credit stayed available, which is the free-credit abuse the next test
        // proves is now closed.
        Event event = standardEvent();

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/rsvp").with(caller("uid-gate-credit")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));

        Long userId = users.findByFirebaseUid("uid-gate-credit").orElseThrow().getId();
        Membership membership = memberships.findByUserId(userId).orElseThrow();
        assertThat(membership.isFirstEventCreditUsed())
                .as("a FREE-first direct RSVP is a commitment — it must spend the credit (TM-629)")
                .isTrue();
        assertThat(membership.getFirstEventCreditEventId()).isEqualTo(event.getId());
        assertThat(membership.getFirstEventCreditConsumedAt()).isNotNull();
    }

    @Test
    void secondFreeFirstDirectRsvpIsPricedOnceTheCreditIsSpent() throws Exception {
        // The TM-625a free-credit abuse, end to end: pre-fix, a pay-per-event caller could direct-RSVP
        // a priced event, leave, and direct-RSVP the next priced event — each landing resolved
        // FIRST_EVENT_FREE because nothing ever consumed the credit (the exact "repeatedly get first
        // event free" loop). Now the first landing spends it, so the SECOND priced event resolves PAY
        // and the gate demands checkout. (Pre-fix this sequence ended 200 GOING, not 402.)
        Event first = standardEvent();
        Event second = standardEvent();

        mockMvc.perform(post("/api/v1/events/" + first.getId() + "/rsvp").with(caller("uid-gate-credit-2")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
        // Leave event one (the direct verb — leaving is never gated and does NOT return the credit),
        // so the one-active-event rule can't mask the outcome on event two.
        mockMvc.perform(delete("/api/v1/events/" + first.getId() + "/rsvp").with(caller("uid-gate-credit-2")))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/events/" + second.getId() + "/rsvp").with(caller("uid-gate-credit-2")))
                .andExpect(status().isPaymentRequired())
                .andExpect(jsonPath("$.detail").value(containsString("checkout")));

        Long userId = users.findByFirebaseUid("uid-gate-credit-2").orElseThrow().getId();
        assertThat(attendanceCount(second.getId(), userId))
                .as("the second freebie attempt must write NO attendance row")
                .isZero();
        // The credit was consumed exactly once, by the FIRST event.
        Membership membership = memberships.findByUserId(userId).orElseThrow();
        assertThat(membership.isFirstEventCreditUsed()).isTrue();
        assertThat(membership.getFirstEventCreditEventId()).isEqualTo(first.getId());
        Mockito.verifyNoInteractions(paymentProvider);
    }

    @Test
    void waitlistedFreeFirstMemberStillClaimsTheEventThatConsumedTheirCredit() throws Exception {
        // The claim continuation of the consume-on-commitment rule (TM-629): a FREE-first RSVP that
        // landed WAITLISTED already spent the credit ON THIS EVENT. When a spot frees, the claim
        // re-resolves the entitlement — the credit must still count as available FOR THE EVENT THAT
        // CONSUMED IT (EntitlementService), or the member's own free event would 402 them at claim
        // time and demand payment for a place their credit already bought.
        Event event = standardEvent();
        Long userId = seedUser("uid-gate-credit-claim");
        Membership membership = new Membership(userId, Instant.now());
        membership.consumeFirstEventCredit(event.getId(), Instant.now()); // spent by the waitlist landing
        memberships.save(membership);
        attendance.save(new EventAttendance(event.getId(), userId, AttendanceState.WAITLISTED));

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/claim").with(caller("uid-gate-credit-claim")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.state").value("GOING"));
        Mockito.verifyNoInteractions(paymentProvider); // never asked to pay for their own free event
    }

    // ------------------------------------------------------------------ fixtures

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long attendanceCount(Long eventId, Long userId) {
        return jdbc.queryForObject(
                "select count(*) from event_attendance where event_id = ? and user_id = ?",
                Long.class,
                eventId,
                userId);
    }

    /** Seed a bare account for {@code uid} (membership JIT-enrols on first sight, exactly as prod). */
    private Long seedUser(String uid) {
        return users.save(new User(uid, uid + "@example.com", "Member")).getId();
    }

    /** Seed an account + a membership at {@code tier} for {@code uid}; {@code creditUsed} spends the credit. */
    private void seedMembership(String uid, MembershipTier tier, boolean creditUsed) {
        Long userId = seedUser(uid);
        Membership membership = new Membership(userId, Instant.now());
        if (tier != MembershipTier.PAY_PER_EVENT) {
            membership.changeTier(tier, Instant.now());
        }
        memberships.save(membership);
        if (creditUsed) {
            jdbc.update("update membership set first_event_credit_used = true where user_id = ?", userId);
        }
    }

    private Long creatorId() {
        return users.save(new User("uid-gate-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now, standard (£5, non-premium) event starting 2 days out. */
    private Event standardEvent() {
        return saveEvent(e -> {
            e.setPricePence(STANDARD_PRICE);
            e.setPremium(false);
        });
    }

    /** A PUBLISHED, visible-now premium (£15) event starting 2 days out. */
    private Event premiumEvent() {
        return saveEvent(e -> {
            e.setPricePence(PREMIUM_PRICE);
            e.setPremium(true);
        });
    }

    /** A PUBLISHED, visible-now event starting 2 days out; {@code tweak} customises price/premium. */
    private Event saveEvent(Consumer<Event> tweak) {
        Instant now = Instant.now();
        Event event = new Event(
                "Paid gate " + UUID.randomUUID(),
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
}
