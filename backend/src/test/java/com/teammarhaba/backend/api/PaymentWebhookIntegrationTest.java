package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

/**
 * {@code POST /api/v1/payments/revolut/webhook} end to end (TM-478) over a real Postgres. Proves the other
 * half of the PAY path: a verified settled webhook confirms the local order ({@code PENDING → CONFIRMED})
 * and performs the RSVP that checkout held back; a repeat delivery is a no-op (idempotent); an unverifiable
 * payload gets a 401 and changes nothing; and the endpoint is reachable WITHOUT authentication (Revolut is
 * not a signed-in user — it is permit-listed but signature-guarded).
 *
 * <p>The {@link PaymentProvider} is mocked, so BOTH create-order and signature verification are stubbed —
 * there is no live Revolut call. The real adapter (HTTP + HMAC) is unit-tested in
 * {@code RevolutPaymentProviderTest}; this class proves the wiring: verify → confirm → RSVP → idempotency.
 */
@AutoConfigureMockMvc
class PaymentWebhookIntegrationTest extends AbstractIntegrationTest {

    private static final String WEBHOOK_PATH = "/api/v1/payments/revolut/webhook";

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

    // ------------------------------------------------------------------ confirm + RSVP + idempotency

    @Test
    void settledWebhookConfirmsOrderAndPerformsRsvpIdempotently() throws Exception {
        // Seed a PAY checkout → a PENDING order carrying a known provider order id (create-order stubbed).
        Event event = premiumEvent();
        when(paymentProvider.name()).thenReturn("revolut");
        when(paymentProvider.currency()).thenReturn("GBP"); // the seam-exposed charge currency (TM-629)
        when(paymentProvider.createOrder(anyInt(), anyString(), anyString()))
                .thenReturn(new PaymentOrder("rev-hook-1", "tok-1"));
        mockMvc.perform(post("/api/v1/events/" + event.getId() + "/checkout").with(caller("uid-wh-pay")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.order.status").value("PENDING"));

        Long userId = users.findByFirebaseUid("uid-wh-pay").orElseThrow().getId();
        // The RSVP is held back — no attendance row until the payment settles.
        assertThat(attendanceCount(event.getId(), userId)).isZero();

        // A VERIFIED, settled webhook for that order → confirm the order + perform the RSVP.
        when(paymentProvider.parseWebhookEvent(any(), any(), any()))
                .thenReturn(Optional.of(new PaymentWebhookEvent("rev-hook-1", true)));
        mockMvc.perform(webhook()).andExpect(status().isOk());

        assertThat(orders.findByProviderOrderId("rev-hook-1").orElseThrow().getStatus())
                .isEqualTo(OrderStatus.CONFIRMED);
        assertThat(attendanceCount(event.getId(), userId)).isEqualTo(1L);

        // Idempotent: a repeat delivery confirms nothing and does not double-RSVP.
        mockMvc.perform(webhook()).andExpect(status().isOk());
        assertThat(orders.findByProviderOrderId("rev-hook-1").orElseThrow().getStatus())
                .isEqualTo(OrderStatus.CONFIRMED);
        assertThat(attendanceCount(event.getId(), userId)).isEqualTo(1L);
    }

    // ------------------------------------------------------------------ unverifiable → 401, no change

    @Test
    void unverifiedWebhookGets401AndChangesNothing() throws Exception {
        // The provider cannot verify the payload (bad/absent signature) → empty → controller answers 401.
        when(paymentProvider.parseWebhookEvent(any(), any(), any())).thenReturn(Optional.empty());
        mockMvc.perform(post(WEBHOOK_PATH).content("{}")).andExpect(status().isUnauthorized());
    }

    // ------------------------------------------------------------------ verified but unknown order → 200 no-op

    @Test
    void verifiedWebhookForUnknownOrderIsAcknowledgedAsNoOp() throws Exception {
        // A verified event for an order we never created (e.g. another environment) — acknowledged (2xx),
        // acted on for nothing. Proves the endpoint is reachable UNAUTHENTICATED (no caller() principal).
        when(paymentProvider.parseWebhookEvent(any(), any(), any()))
                .thenReturn(Optional.of(new PaymentWebhookEvent("no-such-order-" + UUID.randomUUID(), true)));
        mockMvc.perform(webhook()).andExpect(status().isOk());
    }

    // ------------------------------------------------------------------ fixtures

    private org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder webhook() {
        return post(WEBHOOK_PATH)
                .content("{}")
                .header("Revolut-Signature", "v1=stub")
                .header("Revolut-Request-Timestamp", "1700000000");
    }

    private Long attendanceCount(Long eventId, Long userId) {
        return jdbc.queryForObject(
                "select count(*) from event_attendance where event_id = ? and user_id = ?",
                Long.class,
                eventId,
                userId);
    }

    private static RequestPostProcessor caller(String uid) {
        return authentication(new UsernamePasswordAuthenticationToken(
                new VerifiedUser(uid, uid + "@example.com"), null, List.of()));
    }

    private Long creatorId() {
        return users.save(new User("uid-wh-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now premium (£15) event starting 2 days out → a PAY_PER_EVENT caller PAYs. */
    private Event premiumEvent() {
        return saveEvent(e -> {
            e.setPricePence(1500);
            e.setPremium(true);
            e.setStartAt(Instant.now().plus(2, ChronoUnit.DAYS));
        });
    }

    private Event saveEvent(Consumer<Event> tweak) {
        Instant now = Instant.now();
        Event event = new Event(
                "Webhook " + UUID.randomUUID(),
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
