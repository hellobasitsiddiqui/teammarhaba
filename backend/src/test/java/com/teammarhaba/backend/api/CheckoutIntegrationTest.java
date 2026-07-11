package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.membership.Membership;
import com.teammarhaba.backend.membership.MembershipRepository;
import com.teammarhaba.backend.membership.MembershipTier;
import com.teammarhaba.backend.membership.Order;
import com.teammarhaba.backend.membership.OrderRepository;
import com.teammarhaba.backend.payments.PaymentOrder;
import com.teammarhaba.backend.payments.PaymentProvider;
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
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code POST /api/v1/events/{id}/checkout} and {@code .../checkout/cancel} end to end (TM-477): RSVP goes
 * through a checkout that resolves the TM-476 entitlement then records an order. Exercises every branch of
 * the build note over a real Postgres — FREE (credit consumed), INCLUDED, PAY (pending order, credit
 * untouched), idempotency per (user, event), and cancel/reverse (credit returned inside the window,
 * forfeited outside). The pure tier × event rule matrix lives in {@code EntitlementResolverTest}; this
 * class proves the checkout wiring, the order records, and the credit ledger.
 *
 * <p>The suite shares one database, so every case uses a unique caller uid and its own seeded event.
 */
@AutoConfigureMockMvc
class CheckoutIntegrationTest extends AbstractIntegrationTest {

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
    private OrderRepository orders;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper json;

    // Mock the payment provider so the PAY branch creates a provider order with NO live Revolut call
    // (TM-478): create-order is stubbed to return a canned id + token. The real adapter's HTTP + signature
    // handling is unit-tested in RevolutPaymentProviderTest.
    @MockitoBean
    private PaymentProvider paymentProvider;

    // ------------------------------------------------------------------ FREE (first-event credit)

    @Test
    void freeFirstEventConfirmsAndConsumesCredit() throws Exception {
        Event event = standardEvent(2, ChronoUnit.DAYS);
        var who = caller("uid-co-free");

        // A brand-new PAY_PER_EVENT caller with the credit available → FREE, frictionless: a CONFIRMED £0
        // order and the RSVP lands GOING, no payment.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.paymentRequired").value(false))
                .andExpect(jsonPath("$.order.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.order.amountPence").value(0))
                .andExpect(jsonPath("$.rsvp.state").value("GOING"));

        // The first-event credit was consumed on commitment, recording exactly which event spent it.
        Long userId = users.findByFirebaseUid("uid-co-free").orElseThrow().getId();
        Membership membership = memberships.findByUserId(userId).orElseThrow();
        assertThat(membership.isFirstEventCreditUsed()).isTrue();
        assertThat(membership.getFirstEventCreditEventId()).isEqualTo(event.getId());
        assertThat(membership.getFirstEventCreditConsumedAt()).isNotNull();
        assertThat(orders.findByUserIdAndEventId(userId, event.getId())).isPresent();
    }

    // ------------------------------------------------------------------ INCLUDED (tier covers it)

    @Test
    void includedMonthlyConfirmsWithoutTouchingCredit() throws Exception {
        Event event = standardEvent(2, ChronoUnit.DAYS);
        seedMembership("uid-co-monthly", MembershipTier.MONTHLY, false);

        // MONTHLY on a standard event → INCLUDED: a CONFIRMED £0 order, RSVP lands, no payment.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout").with(caller("uid-co-monthly")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.paymentRequired").value(false))
                .andExpect(jsonPath("$.order.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.order.amountPence").value(0))
                .andExpect(jsonPath("$.rsvp.state").value("GOING"));

        // INCLUDED consumes nothing — the first-event credit is untouched (still available).
        Long userId = users.findByFirebaseUid("uid-co-monthly").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId).orElseThrow().isFirstEventCreditUsed())
                .isFalse();
    }

    // ------------------------------------------------------------------ PAY (pending order, credit kept)

    @Test
    void payPremiumCreatesPendingOrderLeavesCreditAndDoesNotRsvp() throws Exception {
        Event event = premiumEvent();
        var who = caller("uid-co-pay");

        // Stub the provider create-order: the PAY branch persists the returned id and returns the token.
        when(paymentProvider.name()).thenReturn("revolut");
        when(paymentProvider.currency()).thenReturn("GBP"); // the seam-exposed charge currency (TM-629)
        when(paymentProvider.createOrder(anyInt(), anyString(), anyString()))
                .thenReturn(new PaymentOrder("rev-order-pay", "tok-pay-abc"));

        // A PAY_PER_EVENT caller WITH their credit available on a premium event → PAY (never free): a
        // PENDING order for the amount, "payment required", the Revolut client token, and NO RSVP.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.paymentRequired").value(true))
                .andExpect(jsonPath("$.order.status").value("PENDING"))
                .andExpect(jsonPath("$.order.amountPence").value(PREMIUM_PRICE))
                // Fresh PAY response carries the DB-assigned timestamp too (finding #24, TM-629).
                .andExpect(jsonPath("$.order.createdAt").isNotEmpty())
                .andExpect(jsonPath("$.paymentToken").value("tok-pay-abc"))
                .andExpect(jsonPath("$.rsvp").doesNotExist());

        Long userId = users.findByFirebaseUid("uid-co-pay").orElseThrow().getId();
        // The provider order id + provider are persisted on the local order (the webhook match key, V37).
        Order order = orders.findByUserIdAndEventId(userId, event.getId()).orElseThrow();
        assertThat(order.getProviderOrderId()).isEqualTo("rev-order-pay");
        assertThat(order.getProvider()).isEqualTo("revolut");
        // The credit is NOT leaked onto a premium event — still available after a PAY checkout.
        assertThat(memberships.findByUserId(userId).orElseThrow().isFirstEventCreditUsed())
                .as("a PAY checkout must not consume the first-event credit")
                .isFalse();
        // PAY does not RSVP: the caller stays unconfirmed until payment settles (TM-478).
        Long attendance = jdbc.queryForObject(
                "select count(*) from event_attendance where event_id = ? and user_id = ?",
                Long.class,
                event.getId(),
                userId);
        assertThat(attendance).isZero();
    }

    // ------------------------------------------------------------------ fresh createdAt (TM-629)

    @Test
    void freshCheckoutResponseCarriesTheDbCreatedAtTimestamp() throws Exception {
        // Regression for review finding #24 (TM-629): orders.created_at is DB-generated (DEFAULT now())
        // and, without @Generated on the mapping, was never read back on insert — so a FRESH checkout
        // serialised "createdAt": null while idempotent repeats and GET /me/orders returned the real
        // timestamp: an inconsistent wire shape OrderView's own contract mispredicted. @Generated makes
        // Hibernate re-read the DB value inside the same transaction, so the first response already
        // carries it.
        Event event = standardEvent(2, ChronoUnit.DAYS);

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout").with(caller("uid-co-created-at")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.order.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.order.createdAt").isNotEmpty());
    }

    // ------------------------------------------------------------------ idempotency per (user, event)

    @Test
    void repeatCheckoutIsIdempotentReturningTheSameOrder() throws Exception {
        Event event = standardEvent(2, ChronoUnit.DAYS);
        var who = caller("uid-co-idem");

        Long firstOrderId = orderId(mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout")
                        .with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.order.status").value("CONFIRMED"))
                .andReturn()
                .getResponse()
                .getContentAsString());

        // A repeat checkout returns the very same order — never a duplicate.
        Long secondOrderId = orderId(mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout")
                        .with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.order.status").value("CONFIRMED"))
                .andReturn()
                .getResponse()
                .getContentAsString());

        assertThat(secondOrderId).isEqualTo(firstOrderId);

        // Exactly one order row for this (user, event); the credit was consumed exactly once.
        Long userId = users.findByFirebaseUid("uid-co-idem").orElseThrow().getId();
        Long orderCount = jdbc.queryForObject(
                "select count(*) from orders where event_id = ? and user_id = ?", Long.class, event.getId(), userId);
        assertThat(orderCount).isEqualTo(1L);
        assertThat(memberships.findByUserId(userId).orElseThrow().isFirstEventCreditUsed())
                .isTrue();
    }

    // ------------------------------------------------------------------ cancel / reverse (inside window)

    @Test
    void cancelInsideWindowReversesCommitmentAndReturnsCredit() throws Exception {
        // Event 2 days out → cancelling now is well before the 24h cancellation window → reversible.
        Event event = standardEvent(2, ChronoUnit.DAYS);
        var who = caller("uid-co-cancel-in");

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.order.status").value("CONFIRMED"));

        Long userId = users.findByFirebaseUid("uid-co-cancel-in").orElseThrow().getId();
        assertThat(memberships.findByUserId(userId).orElseThrow().isFirstEventCreditUsed())
                .isTrue();

        // Cancelling inside the window reverses: the order is CANCELLED and the credit is returned.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout/cancel").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.reversed").value(true))
                .andExpect(jsonPath("$.creditReturned").value(true))
                .andExpect(jsonPath("$.cancel.lateCancel").value(false))
                .andExpect(jsonPath("$.order.status").value("CANCELLED"));

        Membership membership = memberships.findByUserId(userId).orElseThrow();
        assertThat(membership.isFirstEventCreditUsed()).isFalse();
        assertThat(membership.getFirstEventCreditEventId()).isNull();
    }

    // ------------------------------------------------------------------ cancel / forfeit (outside window)

    @Test
    void cancelOutsideWindowForfeitsCreditAndKeepsOrderConfirmed() throws Exception {
        // Event 2 hours out → RSVP still allowed (before the 1h booking cutoff) but cancelling now is
        // INSIDE the 24h cancellation window → a late cancel → forfeit.
        Event event = standardEvent(2, ChronoUnit.HOURS);
        var who = caller("uid-co-cancel-out");

        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.order.status").value("CONFIRMED"));

        Long userId = users.findByFirebaseUid("uid-co-cancel-out").orElseThrow().getId();

        // Missing the window: the caller still leaves, but the credit is forfeited and the order stays
        // CONFIRMED (consumed/forfeited even on a no-show).
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout/cancel").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.reversed").value(false))
                .andExpect(jsonPath("$.creditReturned").value(false))
                .andExpect(jsonPath("$.cancel.lateCancel").value(true))
                .andExpect(jsonPath("$.order.status").value("CONFIRMED"));

        assertThat(memberships.findByUserId(userId).orElseThrow().isFirstEventCreditUsed())
                .as("a forfeited credit stays consumed")
                .isTrue();
    }

    // ------------------------------------------------------------------ 401

    @Test
    void anonymousCheckoutGets401() throws Exception {
        Event event = standardEvent(2, ChronoUnit.DAYS);
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout"))
                .andExpect(status().isUnauthorized());
    }

    // ------------------------------------------------------------------ fixtures

    private Long orderId(String body) throws Exception {
        JsonNode node = json.readTree(body).path("order").path("id");
        return node.asLong();
    }

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long creatorId() {
        return users.save(new User("uid-co-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now, standard (£5, non-premium) event starting {@code amount} of {@code unit} out. */
    private Event standardEvent(long amount, ChronoUnit unit) {
        return saveEvent(e -> {
            e.setPricePence(STANDARD_PRICE);
            e.setPremium(false);
            e.setStartAt(Instant.now().plus(amount, unit));
        });
    }

    /** A PUBLISHED, visible-now premium (£15) event starting 2 days out. */
    private Event premiumEvent() {
        return saveEvent(e -> {
            e.setPricePence(PREMIUM_PRICE);
            e.setPremium(true);
            e.setStartAt(Instant.now().plus(2, ChronoUnit.DAYS));
        });
    }

    /** A PUBLISHED, visible-now event; {@code tweak} customises price/premium/start. */
    private Event saveEvent(Consumer<Event> tweak) {
        Instant now = Instant.now();
        Event event = new Event(
                "Checkout " + UUID.randomUUID(),
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

    /** Seed an account + a membership at {@code tier} for {@code uid}; {@code creditUsed} spends the credit. */
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
