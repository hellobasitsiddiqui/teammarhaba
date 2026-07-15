package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.AbstractIntegrationTest;
import com.teammarhaba.backend.auth.VerifiedUser;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.membership.Order;
import com.teammarhaba.backend.membership.OrderRepository;
import com.teammarhaba.backend.membership.OrderStatus;
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
 * PENDING-order resume re-mint over HTTP (TM-738 P1 {@code resumingPendingPayOrderRemintsFreshTokenOverHttp},
 * TM-760): a buyer resuming a still-{@code PENDING} PAY order — by re-POSTing
 * {@code /api/v1/events/{id}/checkout} — gets a FRESH single-use provider token back onto the SAME order row,
 * so a browser that lost its token can mount the widget again.
 *
 * <p>Characterization test for the EXISTING behaviour TM-739 shipped ({@code CheckoutService.checkout}, the
 * {@code existing.getStatus() == PENDING} branch). The Revolut order token is single-use and not stored, so
 * the pre-TM-739 unconditional idempotent early-return handed a resuming buyer {@code paymentToken: null} and
 * the widget could never re-mount. The fix re-mints — it best-effort voids the old provider order, opens a
 * new one, restamps the row, and returns {@code paymentRequired: true} with a fresh token — all WITHOUT a
 * separate resume endpoint (the client just re-POSTs checkout). This class pins that over a real Postgres.
 *
 * <p>The {@link PaymentProvider} is mocked so no live Revolut call is made: the two create-orders return
 * distinct ids + tokens, and the void call is verified. The real adapter (HTTP + HMAC) is unit-tested in
 * {@code RevolutPaymentProviderTest}. The suite shares one database, so this case uses a unique caller uid +
 * its own event.
 */
@AutoConfigureMockMvc
class CheckoutResumeRemintIntegrationTest extends AbstractIntegrationTest {

    private static final int PREMIUM_PRICE = 1500; // £15 — a premium event a PAY_PER_EVENT caller must pay for

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private EventRepository events;

    @Autowired
    private UserRepository users;

    @Autowired
    private OrderRepository orders;

    @Autowired
    private JdbcTemplate jdbc;

    @MockitoBean
    private PaymentProvider paymentProvider;

    // ----------------------------------------------- resume a PENDING order → fresh token, same order row

    @Test
    void resumingAPendingPayOrderRemintsAFreshTokenOverHttp() throws Exception {
        Event event = premiumEvent();
        var who = caller("uid-resume-pay");
        when(paymentProvider.name()).thenReturn("revolut");
        when(paymentProvider.currency()).thenReturn("GBP");
        // Two DISTINCT provider orders: the first PAY mints one, the resume mints a fresh one.
        when(paymentProvider.createOrder(anyInt(), anyString(), anyString()))
                .thenReturn(
                        new PaymentOrder("rev-resume-first", "tok-resume-first"),
                        new PaymentOrder("rev-resume-second", "tok-resume-second"));

        // 1) First PAY checkout → a PENDING order with the FIRST provider order id + its client token.
        String firstBody = mockMvc.perform(
                        post("/api/v1/events/" + event.getId() + "/checkout").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.paymentRequired").value(true))
                .andExpect(jsonPath("$.order.status").value("PENDING"))
                .andExpect(jsonPath("$.order.amountPence").value(PREMIUM_PRICE))
                .andExpect(jsonPath("$.paymentToken").value("tok-resume-first"))
                .andReturn()
                .getResponse()
                .getContentAsString();
        Long firstOrderId = orderId(firstBody);

        Long userId = users.findByFirebaseUid("uid-resume-pay").orElseThrow().getId();
        assertThat(orders.findByProviderOrderId("rev-resume-first").orElseThrow().getId())
                .isEqualTo(firstOrderId);

        // 2) The buyer lost the single-use token (closed the tab) and re-POSTs checkout to RESUME. The
        // still-PENDING order is re-minted: a FRESH provider token comes back, still "payment required",
        // on the SAME order row (never a duplicate — UNIQUE (user, event) holds).
        String resumeBody = mockMvc.perform(
                        post("/api/v1/events/" + event.getId() + "/checkout").with(who))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.paymentRequired").value(true))
                .andExpect(jsonPath("$.order.status").value("PENDING"))
                .andExpect(jsonPath("$.order.id").value(firstOrderId))
                .andExpect(jsonPath("$.order.amountPence").value(PREMIUM_PRICE))
                // A FRESH token — never the stale single-use one from the first mint.
                .andExpect(jsonPath("$.paymentToken").value("tok-resume-second"))
                .andReturn()
                .getResponse()
                .getContentAsString();
        assertThat(orderId(resumeBody)).isEqualTo(firstOrderId);

        // The row now points at the SECOND provider order (the webhook match key was restamped to the
        // re-minted order), and there is still exactly ONE order row for this (user, event).
        Order resumed = orders.findByUserIdAndEventId(userId, event.getId()).orElseThrow();
        assertThat(resumed.getId()).isEqualTo(firstOrderId);
        assertThat(resumed.getStatus()).isEqualTo(OrderStatus.PENDING);
        assertThat(resumed.getProviderOrderId()).isEqualTo("rev-resume-second");
        Long orderCount = jdbc.queryForObject(
                "select count(*) from orders where event_id = ? and user_id = ?", Long.class, event.getId(), userId);
        assertThat(orderCount).isEqualTo(1L);

        // The old, superseded provider order was best-effort voided so a payment completed in the stale tab
        // can't capture money against an order we've re-minted past.
        verify(paymentProvider).cancelOrder(eq("rev-resume-first"));
        // Two mints total: the first PAY and the resume.
        verify(paymentProvider, times(2)).createOrder(anyInt(), anyString(), anyString());
    }

    // ------------------------------------------------------------------ fixtures

    private Long orderId(String body) throws Exception {
        return new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(body)
                .path("order")
                .path("id")
                .asLong();
    }

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long creatorId() {
        return users.save(new User("uid-resume-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
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
                "Resume " + UUID.randomUUID(),
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
