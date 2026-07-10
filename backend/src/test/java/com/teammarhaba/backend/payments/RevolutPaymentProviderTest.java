package com.teammarhaba.backend.payments;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Unit coverage of the {@link RevolutPaymentProvider} adapter (TM-478) with <strong>no live Revolut
 * calls</strong>: create-order is exercised against a loopback {@link HttpServer} stub standing in for the
 * Merchant API (so the request shape + response parsing are asserted deterministically), and webhook
 * verification is exercised with a REAL HMAC-SHA256 signature computed the way Revolut computes it. This
 * is the CI bar — the actual sandbox handshake is the post-deploy live smoke test.
 */
class RevolutPaymentProviderTest {

    private static final String SECRET_KEY = "sk_test_secret";
    private static final String WEBHOOK_SECRET = "wsk_test_signing_secret";
    private static final String API_VERSION = "2024-09-01";

    private HttpServer server;
    private String baseUrl;
    private final ObjectMapper json = new ObjectMapper();

    // Captures what the adapter actually sent, so the request contract can be asserted.
    private final AtomicReference<String> capturedMethod = new AtomicReference<>();
    private final AtomicReference<String> capturedPath = new AtomicReference<>();
    private final AtomicReference<String> capturedAuth = new AtomicReference<>();
    private final AtomicReference<String> capturedApiVersion = new AtomicReference<>();
    private final AtomicReference<String> capturedBody = new AtomicReference<>();

    // What the stub Merchant API returns for the next create-order call.
    private volatile int responseStatus = 201;
    private volatile String responseBody = "{\"id\":\"rev-order-1\",\"token\":\"tok-abc\",\"state\":\"pending\"}";

    @BeforeEach
    void startStub() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        // One generic capture-and-respond handler; HttpServer prefix-matches contexts, so it also
        // serves /api/orders/{id}/payments and /api/customers/{id}/payment_methods (TM-620).
        server.createContext("/api/orders", this::handleCreateOrder);
        server.createContext("/api/customers", this::handleCreateOrder);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopStub() {
        server.stop(0);
    }

    private void handleCreateOrder(HttpExchange exchange) throws java.io.IOException {
        capturedMethod.set(exchange.getRequestMethod());
        capturedPath.set(exchange.getRequestURI().getPath());
        capturedAuth.set(exchange.getRequestHeaders().getFirst("Authorization"));
        capturedApiVersion.set(exchange.getRequestHeaders().getFirst("Revolut-Api-Version"));
        capturedBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        byte[] out = responseBody.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(responseStatus, out.length);
        exchange.getResponseBody().write(out);
        exchange.close();
    }

    private RevolutPaymentProvider provider(String secretKey, String webhookSecret) {
        RevolutProperties props = new RevolutProperties(secretKey, baseUrl, API_VERSION, webhookSecret, "GBP");
        return new RevolutPaymentProvider(props, json, HttpClient.newHttpClient());
    }

    // ------------------------------------------------------------------ create order

    @Test
    void createOrderPostsMinorAmountWithBearerAuthAndParsesIdAndToken() {
        PaymentOrder order = provider(SECRET_KEY, WEBHOOK_SECRET).createOrder(500, "GBP", "42");

        // Response parsed into the permanent id + temporary client token.
        assertThat(order.id()).isEqualTo("rev-order-1");
        assertThat(order.token()).isEqualTo("tok-abc");

        // Request contract: POST /api/orders, Bearer secret key, dated api-version, minor-unit amount.
        assertThat(capturedMethod.get()).isEqualTo("POST");
        assertThat(capturedPath.get()).isEqualTo("/api/orders");
        assertThat(capturedAuth.get()).isEqualTo("Bearer " + SECRET_KEY);
        assertThat(capturedApiVersion.get()).isEqualTo(API_VERSION);
        assertThat(readBody().path("amount").asInt()).isEqualTo(500);
        assertThat(readBody().path("currency").asText()).isEqualTo("GBP");
        assertThat(readBody().path("merchant_order_ext_ref").asText()).isEqualTo("42");
    }

    @Test
    void createOrderFailsLoudlyWhenSecretKeyMissing() {
        // No secret configured → never fire an unauthenticated request; fail closed instead.
        assertThatThrownBy(() -> provider("", WEBHOOK_SECRET).createOrder(500, "GBP", "1"))
                .isInstanceOf(PaymentProviderException.class);
    }

    @Test
    void createOrderThrowsOnNon2xx() {
        responseStatus = 400;
        responseBody = "{\"message\":\"bad request\"}";
        assertThatThrownBy(() -> provider(SECRET_KEY, WEBHOOK_SECRET).createOrder(500, "GBP", "1"))
                .isInstanceOf(PaymentProviderException.class);
    }

    @Test
    void createOrderThrowsWhenResponseMissingIdOrToken() {
        responseStatus = 201;
        responseBody = "{\"state\":\"pending\"}"; // no id / token
        assertThatThrownBy(() -> provider(SECRET_KEY, WEBHOOK_SECRET).createOrder(500, "GBP", "1"))
                .isInstanceOf(PaymentProviderException.class);
    }

    // ------------------------------------------------------------------ subscriptions (TM-620)

    @Test
    void createCustomerPostsEmailAndFullNameAndParsesId() {
        responseBody = "{\"id\":\"cust-1\",\"email\":\"sub@example.com\"}";

        String id = provider(SECRET_KEY, WEBHOOK_SECRET).createCustomer("sub@example.com", "+447700900000", "Sub Scriber");

        assertThat(id).isEqualTo("cust-1");
        assertThat(capturedMethod.get()).isEqualTo("POST");
        assertThat(capturedPath.get()).isEqualTo("/api/customers");
        assertThat(capturedAuth.get()).isEqualTo("Bearer " + SECRET_KEY);
        assertThat(readBody().path("email").asText()).isEqualTo("sub@example.com");
        assertThat(readBody().path("full_name").asText()).isEqualTo("Sub Scriber");
    }

    @Test
    void createCustomerOmitsBlankFieldsAndFailsOnMissingId() {
        responseBody = "{\"id\":\"cust-2\"}";
        provider(SECRET_KEY, WEBHOOK_SECRET).createCustomer(null, null, "Phone Only");
        // A phone-only account has no email — the field must be absent, not an empty string.
        assertThat(readBody().has("email")).isFalse();
        assertThat(readBody().path("full_name").asText()).isEqualTo("Phone Only");

        responseBody = "{\"state\":\"created\"}"; // no id
        assertThatThrownBy(() -> provider(SECRET_KEY, WEBHOOK_SECRET).createCustomer("a@b.c", null, "X"))
                .isInstanceOf(PaymentProviderException.class);
    }

    @Test
    void createOrderForCustomerAttachesTheCustomerId() {
        responseBody = "{\"id\":\"rev-order-9\",\"token\":\"tok-9\",\"state\":\"pending\"}";

        PaymentOrder order =
                provider(SECRET_KEY, WEBHOOK_SECRET).createOrderForCustomer(999, "GBP", "sub-charge:5", "cust-1");

        assertThat(order.id()).isEqualTo("rev-order-9");
        assertThat(order.token()).isEqualTo("tok-9");
        assertThat(capturedPath.get()).isEqualTo("/api/orders");
        assertThat(readBody().path("amount").asInt()).isEqualTo(999);
        assertThat(readBody().path("customer").path("id").asText()).isEqualTo("cust-1");
        assertThat(readBody().path("merchant_order_ext_ref").asText()).isEqualTo("sub-charge:5");
    }

    @Test
    void payWithSavedMethodPostsMerchantInitiatedChargeAndReadsSettledState() {
        responseBody = "{\"id\":\"pay-1\",\"state\":\"completed\"}";

        SavedMethodCharge result =
                provider(SECRET_KEY, WEBHOOK_SECRET).payWithSavedMethod("rev-order-9", "pm-1");

        // The MIT contract: POST /api/orders/{id}/payments with the saved method + initiator=merchant.
        assertThat(capturedMethod.get()).isEqualTo("POST");
        assertThat(capturedPath.get()).isEqualTo("/api/orders/rev-order-9/payments");
        assertThat(readBody().path("saved_payment_method").path("type").asText()).isEqualTo("card");
        assertThat(readBody().path("saved_payment_method").path("id").asText()).isEqualTo("pm-1");
        assertThat(readBody().path("saved_payment_method").path("initiator").asText())
                .isEqualTo("merchant");
        assertThat(result.settled()).isTrue();
    }

    @Test
    void payWithSavedMethodTreatsDeclineAsNotSettled() {
        responseBody = "{\"id\":\"pay-2\",\"state\":\"declined\"}";

        SavedMethodCharge result =
                provider(SECRET_KEY, WEBHOOK_SECRET).payWithSavedMethod("rev-order-9", "pm-1");

        assertThat(result.settled()).isFalse();
        assertThat(result.state()).isEqualTo("declined");
    }

    @Test
    void findMerchantSavedPaymentMethodPicksTheMerchantSavedCard() {
        responseBody = "[" + "{\"id\":\"pm-cust\",\"type\":\"card\",\"saved_for\":\"CUSTOMER\"},"
                + "{\"id\":\"pm-merch\",\"type\":\"card\",\"saved_for\":\"MERCHANT\"}]";

        Optional<String> ref = provider(SECRET_KEY, WEBHOOK_SECRET).findMerchantSavedPaymentMethod("cust-1");

        assertThat(capturedMethod.get()).isEqualTo("GET");
        assertThat(capturedPath.get()).isEqualTo("/api/customers/cust-1/payment_methods");
        // Only a MERCHANT-saved method can be charged off-session — the CUSTOMER one is skipped.
        assertThat(ref).contains("pm-merch");
    }

    @Test
    void findMerchantSavedPaymentMethodEmptyWhenNoneSavedForMerchant() {
        responseBody = "[{\"id\":\"pm-cust\",\"type\":\"card\",\"saved_for\":\"CUSTOMER\"}]";
        assertThat(provider(SECRET_KEY, WEBHOOK_SECRET).findMerchantSavedPaymentMethod("cust-1"))
                .isEmpty();

        responseBody = "[]";
        assertThat(provider(SECRET_KEY, WEBHOOK_SECRET).findMerchantSavedPaymentMethod("cust-1"))
                .isEmpty();
    }

    @Test
    void createCustomerSendsThePhoneForAPhoneOnlyAccount() {
        // TM-623: a phone-only account (no email, no display name) must still register with a real
        // identifying field — previously the request body was literally {}.
        responseBody = "{\"id\":\"cust-3\"}";

        String id = provider(SECRET_KEY, WEBHOOK_SECRET).createCustomer(null, "+447700900123", null);

        assertThat(id).isEqualTo("cust-3");
        assertThat(readBody().has("email")).isFalse();
        assertThat(readBody().has("full_name")).isFalse();
        assertThat(readBody().path("phone").asText()).isEqualTo("+447700900123");
    }

    @Test
    void cancelOrderPostsToTheCancelEndpoint() {
        responseBody = "{\"id\":\"rev-order-9\",\"state\":\"cancelled\"}";

        provider(SECRET_KEY, WEBHOOK_SECRET).cancelOrder("rev-order-9");

        assertThat(capturedMethod.get()).isEqualTo("POST");
        assertThat(capturedPath.get()).isEqualTo("/api/orders/rev-order-9/cancel");
    }

    @Test
    void cancelOrderThrowsOnNon2xxSoCallersCanLogTheBestEffortFailure() {
        responseStatus = 422; // e.g. the order already completed — can no longer be voided
        responseBody = "{\"message\":\"order not cancellable\"}";
        assertThatThrownBy(() -> provider(SECRET_KEY, WEBHOOK_SECRET).cancelOrder("rev-order-9"))
                .isInstanceOf(PaymentProviderException.class);
    }

    @Test
    void refundPostsTheMinorAmountToTheRefundEndpoint() {
        responseBody = "{\"id\":\"refund-1\",\"state\":\"completed\"}";

        provider(SECRET_KEY, WEBHOOK_SECRET).refund("rev-order-9", 500, "GBP", "42");

        assertThat(capturedMethod.get()).isEqualTo("POST");
        assertThat(capturedPath.get()).isEqualTo("/api/orders/rev-order-9/refund");
        assertThat(readBody().path("amount").asInt()).isEqualTo(500);
        assertThat(readBody().path("currency").asText()).isEqualTo("GBP");
        assertThat(readBody().path("merchant_order_ext_ref").asText()).isEqualTo("42");
    }

    @Test
    void refundThrowsOnNon2xxSoTheOrderStaysRefundDue() {
        responseStatus = 400;
        responseBody = "{\"message\":\"already refunded\"}";
        assertThatThrownBy(() -> provider(SECRET_KEY, WEBHOOK_SECRET).refund("rev-order-9", 500, "GBP", "42"))
                .isInstanceOf(PaymentProviderException.class);
    }

    @Test
    void findMerchantSavedPaymentMethodPrefersTheLatestCreatedAt() {
        // TM-623: array position is an undocumented ordering assumption — when created_at is present,
        // the NEWEST merchant-saved card wins even if the provider lists it first.
        responseBody = "["
                + "{\"id\":\"pm-new\",\"type\":\"card\",\"saved_for\":\"MERCHANT\",\"created_at\":\"2026-07-01T10:00:00Z\"},"
                + "{\"id\":\"pm-old\",\"type\":\"card\",\"saved_for\":\"MERCHANT\",\"created_at\":\"2026-01-01T10:00:00Z\"}]";

        Optional<String> ref = provider(SECRET_KEY, WEBHOOK_SECRET).findMerchantSavedPaymentMethod("cust-1");

        assertThat(ref).contains("pm-new");
    }

    // ------------------------------------------------------------------ webhook verification

    @Test
    void verifiesAGenuineCompletedWebhookAsSettled() {
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        String ts = freshTimestamp(); // must be inside the TM-623 replay window to verify
        String signature = "v1=" + sign(WEBHOOK_SECRET, "v1." + ts + "." + body);

        Optional<PaymentWebhookEvent> event =
                provider(SECRET_KEY, WEBHOOK_SECRET).parseWebhookEvent(bytes(body), signature, ts);

        assertThat(event).isPresent();
        assertThat(event.get().providerOrderId()).isEqualTo("rev-order-1");
        assertThat(event.get().paid()).isTrue();
    }

    @Test
    void verifiesANonSettleEventButFlagsItNotPaid() {
        String body = "{\"event\":\"ORDER_PAYMENT_DECLINED\",\"order_id\":\"rev-order-2\"}";
        String ts = freshTimestamp();
        String signature = "v1=" + sign(WEBHOOK_SECRET, "v1." + ts + "." + body);

        Optional<PaymentWebhookEvent> event =
                provider(SECRET_KEY, WEBHOOK_SECRET).parseWebhookEvent(bytes(body), signature, ts);

        assertThat(event).isPresent();
        assertThat(event.get().paid()).isFalse();
    }

    @Test
    void rejectsATamperedSignature() {
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        String ts = freshTimestamp();
        // A signature over a DIFFERENT body must not verify the real one.
        String wrong = "v1=" + sign(WEBHOOK_SECRET, "v1." + ts + ".{\"event\":\"tampered\"}");

        assertThat(provider(SECRET_KEY, WEBHOOK_SECRET).parseWebhookEvent(bytes(body), wrong, ts))
                .isEmpty();
    }

    @Test
    void rejectsAMissingSignatureOrTimestamp() {
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        RevolutPaymentProvider provider = provider(SECRET_KEY, WEBHOOK_SECRET);
        assertThat(provider.parseWebhookEvent(bytes(body), null, freshTimestamp())).isEmpty();
        assertThat(provider.parseWebhookEvent(bytes(body), "v1=abc", null)).isEmpty();
    }

    @Test
    void rejectsEveryWebhookWhenNoSigningSecretConfigured() {
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        String ts = freshTimestamp();
        // Any signature is rejected when the app holds no signing secret (fail-closed) — it never even
        // reaches verification (the blank-secret guard short-circuits first).
        String signature = "v1=" + sign("some-attacker-secret", "v1." + ts + "." + body);
        assertThat(provider(SECRET_KEY, "").parseWebhookEvent(bytes(body), signature, ts))
                .isEmpty();
    }

    @Test
    void rejectsAReplayedWebhookOutsideTheFreshnessWindow() {
        // TM-623: a captured delivery is signed FOREVER (the timestamp is inside the HMAC payload), so
        // freshness is the only thing that stops an attacker replaying it later. Signature valid,
        // timestamp 10 minutes old -> rejected (the controller then answers 401).
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        String staleTs = String.valueOf(System.currentTimeMillis() - 10 * 60 * 1000);
        String signature = "v1=" + sign(WEBHOOK_SECRET, "v1." + staleTs + "." + body);

        assertThat(provider(SECRET_KEY, WEBHOOK_SECRET).parseWebhookEvent(bytes(body), signature, staleTs))
                .isEmpty();
    }

    @Test
    void acceptsAFreshEpochSecondsTimestamp() {
        // Unit tolerance: a 10-digit value is treated as epoch seconds and normalised, so a provider
        // sending seconds instead of milliseconds still verifies while fresh.
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        String seconds = String.valueOf(System.currentTimeMillis() / 1000);
        String signature = "v1=" + sign(WEBHOOK_SECRET, "v1." + seconds + "." + body);

        assertThat(provider(SECRET_KEY, WEBHOOK_SECRET).parseWebhookEvent(bytes(body), signature, seconds))
                .isPresent();
    }

    @Test
    void rejectsAnUnparseableTimestamp() {
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        String garbage = "not-a-timestamp";
        String signature = "v1=" + sign(WEBHOOK_SECRET, "v1." + garbage + "." + body);

        assertThat(provider(SECRET_KEY, WEBHOOK_SECRET).parseWebhookEvent(bytes(body), signature, garbage))
                .isEmpty();
    }

    // ------------------------------------------------------------------ secret hygiene (TM-623)

    @Test
    void propertiesToStringNeverContainsTheSecrets() {
        // A record's generated toString would print both secrets verbatim into any log line carrying
        // the properties object. The override masks them to presence-only.
        RevolutProperties props =
                new RevolutProperties("sk_live_super_secret", baseUrl, API_VERSION, "wsk_super_secret", "GBP");

        assertThat(props.toString()).doesNotContain("sk_live_super_secret").doesNotContain("wsk_super_secret");
        assertThat(props.toString()).contains("***");
        assertThat(new RevolutProperties(null, baseUrl, API_VERSION, null, "GBP").toString()).contains("(unset)");
    }

    // ------------------------------------------------------------------ helpers

    /** A timestamp inside the TM-623 freshness window — signed webhook tests must not look replayed. */
    private static String freshTimestamp() {
        return String.valueOf(System.currentTimeMillis());
    }


    private JsonNode readBody() {
        try {
            return json.readTree(capturedBody.get());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
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
}
