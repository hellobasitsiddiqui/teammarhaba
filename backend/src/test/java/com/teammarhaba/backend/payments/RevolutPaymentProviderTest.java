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
        server.createContext("/api/orders", this::handleCreateOrder);
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

    // ------------------------------------------------------------------ webhook verification

    @Test
    void verifiesAGenuineCompletedWebhookAsSettled() {
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        String ts = "1700000000";
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
        String ts = "1700000000";
        String signature = "v1=" + sign(WEBHOOK_SECRET, "v1." + ts + "." + body);

        Optional<PaymentWebhookEvent> event =
                provider(SECRET_KEY, WEBHOOK_SECRET).parseWebhookEvent(bytes(body), signature, ts);

        assertThat(event).isPresent();
        assertThat(event.get().paid()).isFalse();
    }

    @Test
    void rejectsATamperedSignature() {
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        String ts = "1700000000";
        // A signature over a DIFFERENT body must not verify the real one.
        String wrong = "v1=" + sign(WEBHOOK_SECRET, "v1." + ts + ".{\"event\":\"tampered\"}");

        assertThat(provider(SECRET_KEY, WEBHOOK_SECRET).parseWebhookEvent(bytes(body), wrong, ts))
                .isEmpty();
    }

    @Test
    void rejectsAMissingSignatureOrTimestamp() {
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        RevolutPaymentProvider provider = provider(SECRET_KEY, WEBHOOK_SECRET);
        assertThat(provider.parseWebhookEvent(bytes(body), null, "1700000000")).isEmpty();
        assertThat(provider.parseWebhookEvent(bytes(body), "v1=abc", null)).isEmpty();
    }

    @Test
    void rejectsEveryWebhookWhenNoSigningSecretConfigured() {
        String body = "{\"event\":\"ORDER_COMPLETED\",\"order_id\":\"rev-order-1\"}";
        String ts = "1700000000";
        // Any signature is rejected when the app holds no signing secret (fail-closed) — it never even
        // reaches verification (the blank-secret guard short-circuits first).
        String signature = "v1=" + sign("some-attacker-secret", "v1." + ts + "." + body);
        assertThat(provider(SECRET_KEY, "").parseWebhookEvent(bytes(body), signature, ts))
                .isEmpty();
    }

    // ------------------------------------------------------------------ helpers

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
