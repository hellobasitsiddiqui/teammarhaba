package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.membership.OrderRepository;
import com.teammarhaba.backend.membership.OrderStatus;
import com.teammarhaba.backend.payments.PaymentOrder;
import com.teammarhaba.backend.payments.PaymentProvider;
import com.teammarhaba.backend.payments.PaymentWebhookEvent;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * The buyer-facing settle read (TM-738 P1 {@code settledWebhookMakesOrderVisibleConfirmedViaMyOrders},
 * TM-760): a PAY checkout followed by a VERIFIED settled webhook makes the order visible as
 * {@code CONFIRMED} through {@code GET /api/v1/me/orders} — the exact screen the buyer looks at, not just
 * the repository row.
 *
 * <p>Characterization test for EXISTING behaviour: it stitches together two seams that already ship but are
 * only ever proved in isolation today — {@code PaymentWebhookIntegrationTest} asserts the DB status +
 * attendance after settle, and {@code MyOrdersIntegrationTest} proves the read endpoint against
 * repository-seeded orders. Neither proves the end-to-end money path the buyer actually sees: pay → webhook
 * confirms → the order shows CONFIRMED in "my tickets & purchases". This class pins that.
 *
 * <p>The {@link PaymentProvider} is mocked (no live Revolut call): create-order returns a canned id + token,
 * and the webhook is stubbed to parse as a verified SETTLED event for that order id. The real adapter (HTTP +
 * HMAC) is unit-tested in {@code RevolutPaymentProviderTest}; the suite shares one database, so a unique
 * caller uid + its own event keep this case isolated.
 */
@AutoConfigureMockMvc
class SettledOrderVisibleViaMyOrdersIntegrationTest extends AbstractIntegrationTest {

    private static final String WEBHOOK_PATH = "/api/v1/payments/revolut/webhook";
    private static final int PREMIUM_PRICE = 1500; // £15 — a premium event a PAY_PER_EVENT caller must pay for

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private OrderRepository orders;

    @MockitoBean
    private PaymentProvider paymentProvider;

    // ------------------------------------------------------------------ pay → settle → CONFIRMED in my orders

    @Test
    void settledWebhookMakesTheOrderVisibleAsConfirmedViaMyOrders() throws Exception {
        Event event = premiumEvent();
        when(paymentProvider.name()).thenReturn("revolut");
        when(paymentProvider.currency()).thenReturn("GBP");
        when(paymentProvider.createOrder(anyInt(), anyString(), anyString()))
                .thenReturn(new PaymentOrder("rev-visible-1", "tok-visible-1"));

        // 1) PAY checkout → a PENDING order. Before settle, the buyer's own screen shows it as awaiting payment.
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout").with(caller("uid-visible-pay")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.order.status").value("PENDING"));

        Long orderId = orders.findByProviderOrderId("rev-visible-1").orElseThrow().getId();
        mockMvc.perform(get("/api/v1/me/orders").with(caller("uid-visible-pay")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(orderId))
                .andExpect(jsonPath("$[0].status").value("PENDING"))
                .andExpect(jsonPath("$[0].amountPence").value(PREMIUM_PRICE));

        // 2) A VERIFIED settled webhook confirms the order server-side (the confirm+RSVP seam).
        when(paymentProvider.parseWebhookEvent(any(), any(), any()))
                .thenReturn(Optional.of(
                        new PaymentWebhookEvent("rev-visible-1", PaymentWebhookEvent.Outcome.SETTLED)));
        mockMvc.perform(webhook()).andExpect(status().isOk());

        // The DB row is CONFIRMED (the seam PaymentWebhookIntegrationTest already covers) …
        assertThat(orders.findByProviderOrderId("rev-visible-1").orElseThrow().getStatus())
                .isEqualTo(OrderStatus.CONFIRMED);

        // 3) … AND the buyer now sees it as CONFIRMED through GET /me/orders — the whole point of this test:
        // the settle is reflected on the screen the buyer actually reads, not just in the repository.
        mockMvc.perform(get("/api/v1/me/orders").with(caller("uid-visible-pay")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(orderId))
                .andExpect(jsonPath("$[0].status").value("CONFIRMED"))
                .andExpect(jsonPath("$[0].amountPence").value(PREMIUM_PRICE))
                .andExpect(jsonPath("$[0].eventId").value(event.getId()))
                .andExpect(jsonPath("$[0].createdAt").isNotEmpty());
    }

    // ------------------------------------------------------------------ fixtures

    private org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder webhook() {
        return post(WEBHOOK_PATH)
                .content("{}")
                .header("Revolut-Signature", "v1=stub")
                .header("Revolut-Request-Timestamp", "1700000000");
    }

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long creatorId() {
        return users.save(new User("uid-visible-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now premium (£15) event starting 2 days out → a PAY_PER_EVENT caller PAYs. */
    private Event premiumEvent() {
        return saveEvent(e -> {
            e.setPricePence(PREMIUM_PRICE);
            e.setPremium(true);
            e.setStartAt(Instant.now().plus(2, ChronoUnit.DAYS));
        });
    }

    private Event saveEvent(Consumer<Event> tweak) {
        Instant now = Instant.now();
        Event event = new Event(
                "Visible " + UUID.randomUUID(),
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
