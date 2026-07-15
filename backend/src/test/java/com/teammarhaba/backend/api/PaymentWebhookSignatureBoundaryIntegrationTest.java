package com.teammarhaba.backend.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.teammarhaba.backend.TestcontainersConfiguration;
import com.teammarhaba.backend.event.Event;
import com.teammarhaba.backend.event.EventRepository;
import com.teammarhaba.backend.membership.Order;
import com.teammarhaba.backend.membership.OrderRepository;
import com.teammarhaba.backend.membership.OrderStatus;
import com.teammarhaba.backend.user.User;
import com.teammarhaba.backend.user.UserRepository;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import java.util.function.Consumer;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

/**
 * The internet-facing money endpoint's signature check, exercised through the REAL controller wiring with a
 * REAL HMAC — the seam neither existing test covers (TM-738 P0, {@code webhookSignatureVerifiedAtHttpBoundaryRealHmac}).
 *
 * <p>{@code RevolutPaymentProviderTest} verifies the HMAC by calling {@code parseWebhookEvent} directly on the
 * adapter (no HTTP, no Spring), and {@link PaymentWebhookIntegrationTest} drives the confirm/RSVP wiring but
 * <em>mocks</em> the {@link com.teammarhaba.backend.payments.PaymentProvider PaymentProvider}, so signature
 * verification is stubbed away. This class fills the gap: it wires the <b>real</b> {@code RevolutPaymentProvider}
 * bean (no {@code @MockitoBean}) with a KNOWN webhook signing secret injected via {@link TestPropertySource},
 * then POSTs to {@code POST /api/v1/payments/revolut/webhook} over MockMvc so the {@code Revolut-Signature}
 * HMAC is recomputed and constant-time-compared inside the running app exactly as it is in production.
 *
 * <p>It proves the money endpoint's authenticity guard end to end:
 *
 * <ul>
 *   <li>A payload signed with the configured secret and a fresh timestamp <b>verifies</b> → {@code 200}, the
 *       seeded PENDING order confirms ({@code PENDING → CONFIRMED}) and the held-back RSVP is performed.</li>
 *   <li>A TAMPERED signature (right secret, wrong body) is <b>rejected</b> → {@code 401}, and nothing changes
 *       (order stays PENDING, no attendance) — the endpoint is permit-listed but not open.</li>
 *   <li>A MISSING signature/timestamp is <b>rejected</b> → {@code 401}, no change.</li>
 *   <li>A REPLAYED but genuinely-signed delivery outside the freshness window is <b>rejected</b> → {@code 401},
 *       no change (the timestamp is inside the signed payload, so freshness is the only replay guard).</li>
 * </ul>
 *
 * <p>Its own context (a distinct {@code @TestPropertySource}) so it does not reuse — and is not confused by —
 * the mocked-provider context {@link PaymentWebhookIntegrationTest} caches. The order is seeded directly via
 * the repository (with a known provider order id) rather than through the PAY checkout, so no live Revolut
 * create-order call is made: only the webhook signature/confirm path is exercised, against a real Postgres.
 */
@SpringBootTest
@ActiveProfiles("test")
@Import(TestcontainersConfiguration.class)
@AutoConfigureMockMvc
// Inject a KNOWN webhook signing secret so a genuine HMAC can be computed here and verified by the real
// RevolutPaymentProvider bean. The test profile leaves this blank (fail-closed); with it blank every
// webhook is rejected, so the happy path can only be proven once a real secret is configured. Deliberately
// NOT mocking the PaymentProvider — the point is to run the real signature check through the HTTP boundary.
@TestPropertySource(properties = "app.payments.revolut.webhook-signing-secret=" + PaymentWebhookSignatureBoundaryIntegrationTest.WEBHOOK_SECRET)
class PaymentWebhookSignatureBoundaryIntegrationTest {

    /** The known signing secret injected into the context (see the class-level {@code @TestPropertySource}). */
    static final String WEBHOOK_SECRET = "wsk_boundary_integration_secret";

    private static final String WEBHOOK_PATH = "/api/v1/payments/revolut/webhook";

    /** The Revolut signature scheme's version prefix, in both the header and the signed payload. */
    private static final String SIGNATURE_VERSION = "v1";

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

    // ------------------------------------------------------------------ valid HMAC → 200 + confirm + RSVP

    @Test
    void aGenuinelySignedSettleWebhookVerifiesThroughTheRealControllerAndConfirmsTheOrder() throws Exception {
        // A PENDING PAY order carrying a known provider order id, seeded directly (no live create-order call).
        Seed seed = seedPendingOrder("rev-boundary-ok");
        assertThat(attendanceCount(seed.eventId(), seed.userId())).isZero(); // RSVP is held back until settle

        // A payload signed with the CONFIGURED secret + a fresh timestamp — the real provider recomputes the
        // HMAC inside the app and it matches, so the settle is confirmed and the held-back RSVP performed.
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-boundary-ok\"}";
        String ts = freshTimestamp();
        mockMvc.perform(signedWebhook(body, sign(WEBHOOK_SECRET, payloadToSign(ts, body)), ts))
                .andExpect(status().isOk());

        assertThat(orders.findByProviderOrderId("rev-boundary-ok").orElseThrow().getStatus())
                .isEqualTo(OrderStatus.CONFIRMED);
        assertThat(attendanceCount(seed.eventId(), seed.userId())).isEqualTo(1L);
    }

    // ------------------------------------------------------------------ tampered HMAC → 401, no change

    @Test
    void aTamperedSignatureIsRejectedWith401AndChangesNothing() throws Exception {
        Seed seed = seedPendingOrder("rev-boundary-tampered");

        // Right secret, but signed over a DIFFERENT body → the recomputed HMAC over the ACTUAL body differs,
        // so the constant-time compare fails and the endpoint answers 401. The order must not confirm.
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-boundary-tampered\"}";
        String ts = freshTimestamp();
        String wrongSignature = sign(WEBHOOK_SECRET, payloadToSign(ts, "{\"event\":\"tampered\"}"));
        mockMvc.perform(signedWebhook(body, wrongSignature, ts))
                .andExpect(status().isUnauthorized());

        assertThat(orders.findByProviderOrderId("rev-boundary-tampered").orElseThrow().getStatus())
                .isEqualTo(OrderStatus.PENDING);
        assertThat(attendanceCount(seed.eventId(), seed.userId())).isZero();
    }

    // ------------------------------------------------------------------ wrong-secret HMAC → 401, no change

    @Test
    void aSignatureFromTheWrongSecretIsRejectedWith401AndChangesNothing() throws Exception {
        Seed seed = seedPendingOrder("rev-boundary-wrongsecret");

        // A well-formed signature over the CORRECT body, but computed with an attacker's secret — the app's
        // recomputation with the configured secret differs, so verification fails: 401, no confirm.
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-boundary-wrongsecret\"}";
        String ts = freshTimestamp();
        String forged = sign("attacker-secret", payloadToSign(ts, body));
        mockMvc.perform(signedWebhook(body, forged, ts))
                .andExpect(status().isUnauthorized());

        assertThat(orders.findByProviderOrderId("rev-boundary-wrongsecret").orElseThrow().getStatus())
                .isEqualTo(OrderStatus.PENDING);
        assertThat(attendanceCount(seed.eventId(), seed.userId())).isZero();
    }

    // ------------------------------------------------------------------ missing signature → 401, no change

    @Test
    void aMissingSignatureHeaderIsRejectedWith401AndChangesNothing() throws Exception {
        Seed seed = seedPendingOrder("rev-boundary-nosig");

        // No Revolut-Signature header at all (both headers are optional at the controller so a missing one is
        // an unverifiable request, not a 400) → the provider fails closed → 401.
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-boundary-nosig\"}";
        mockMvc.perform(post(WEBHOOK_PATH)
                        .content(body)
                        .header("Revolut-Request-Timestamp", freshTimestamp()))
                .andExpect(status().isUnauthorized());

        assertThat(orders.findByProviderOrderId("rev-boundary-nosig").orElseThrow().getStatus())
                .isEqualTo(OrderStatus.PENDING);
        assertThat(attendanceCount(seed.eventId(), seed.userId())).isZero();
    }

    // ------------------------------------------------------------------ stale replay → 401, no change

    @Test
    void aReplayedGenuinelySignedWebhookOutsideTheFreshnessWindowIsRejectedWith401() throws Exception {
        Seed seed = seedPendingOrder("rev-boundary-stale");

        // A perfectly valid signature over a genuine body, but the timestamp is 10 minutes old — past the
        // 5-minute replay window. The timestamp is inside the signed payload, so the signature verifies; the
        // freshness check is what rejects it. Proves the replay guard fires through the HTTP boundary: 401,
        // and the order stays PENDING (a captured delivery cannot be replayed to re-confirm).
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-boundary-stale\"}";
        String staleTs = String.valueOf(System.currentTimeMillis() - 10 * 60 * 1000L);
        mockMvc.perform(signedWebhook(body, sign(WEBHOOK_SECRET, payloadToSign(staleTs, body)), staleTs))
                .andExpect(status().isUnauthorized());

        assertThat(orders.findByProviderOrderId("rev-boundary-stale").orElseThrow().getStatus())
                .isEqualTo(OrderStatus.PENDING);
        assertThat(attendanceCount(seed.eventId(), seed.userId())).isZero();
    }

    // ------------------------------------------------------------------ fixtures + signing helpers

    /** A seeded (user, event, PENDING order) triple carrying {@code providerOrderId} as the webhook match key. */
    private record Seed(Long userId, Long eventId, Long orderId) {}

    /**
     * Seed a PENDING PAY order for a fresh buyer against a fresh premium event, carrying {@code providerOrderId}
     * as its provider reference — the same state {@code CheckoutService.checkout}'s PAY branch leaves behind,
     * minus the live create-order HTTP call. The webhook's settle path then confirms it and performs the RSVP.
     */
    private Seed seedPendingOrder(String providerOrderId) {
        Event event = premiumEvent();
        User buyer = users.save(new User("uid-" + providerOrderId + "-" + UUID.randomUUID(), "buyer@example.com", "Buyer"));
        Order order = orders.save(new Order(buyer.getId(), event.getId(), 1500, OrderStatus.PENDING, Instant.now()));
        order.setPaymentReference("revolut", providerOrderId);
        orders.save(order);
        return new Seed(buyer.getId(), event.getId(), order.getId());
    }

    /** POST a signed delivery: raw body + the {@code v1=<hex>} signature header + the timestamp header. */
    private MockHttpServletRequestBuilder signedWebhook(String body, String hexSignature, String timestamp) {
        return post(WEBHOOK_PATH)
                .content(body)
                .header("Revolut-Signature", SIGNATURE_VERSION + "=" + hexSignature)
                .header("Revolut-Request-Timestamp", timestamp);
    }

    /** The exact string Revolut signs: {@code "v1" + "." + timestamp + "." + rawBody}. */
    private static String payloadToSign(String timestamp, String body) {
        return SIGNATURE_VERSION + "." + timestamp + "." + body;
    }

    /** A timestamp inside the 5-minute replay window so a signed webhook does not look replayed. */
    private static String freshTimestamp() {
        return String.valueOf(System.currentTimeMillis());
    }

    /** Lowercase-hex HMAC-SHA256 — the exact primitive the adapter verifies against (Revolut's scheme). */
    private static String sign(String secret, String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] digest = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private Long attendanceCount(Long eventId, Long userId) {
        return jdbc.queryForObject(
                "select count(*) from event_attendance where event_id = ? and user_id = ?",
                Long.class,
                eventId,
                userId);
    }

    private Long creatorId() {
        return users.save(new User("uid-boundary-creator-" + UUID.randomUUID(), "creator@example.com", "Creator"))
                .getId();
    }

    /** A PUBLISHED, visible-now premium (£15) event starting 2 days out — a valid target for a paid RSVP. */
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
                "Boundary " + UUID.randomUUID(),
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
