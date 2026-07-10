package com.teammarhaba.backend.payments;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Revolut Merchant API adapter (TM-478) — the concrete {@link PaymentProvider} behind the membership
 * £5 paid path. Sandbox-first: {@link RevolutProperties#apiBase()} defaults to
 * {@code https://sandbox-merchant.revolut.com} and go-live is just a base + key swap (TM-599). Built on
 * the JDK's own {@link HttpClient} so it adds no HTTP dependency and stays trivially testable against a
 * loopback stub server (no live Revolut calls in CI).
 *
 * <p><b>Create order</b> — {@code POST {base}/api/orders} with the Secret key as a Bearer token and the
 * dated {@code Revolut-Api-Version} header; body is {@code {amount, currency}} in <em>minor units</em>
 * (pence), so {@code Order.amountPence} passes straight through. The response's permanent {@code id}
 * (persisted, reconciled/refunded by) and temporary {@code token} (mounts the client widget) are returned.
 *
 * <p><b>Verify webhook</b> — Revolut signs each webhook with HMAC-SHA256 over
 * {@code "v1." + timestamp + "." + rawBody}, keyed by the webhook <em>signing secret</em> (distinct from
 * the API key), and sends it as {@code Revolut-Signature: v1=<hex>} alongside a
 * {@code Revolut-Request-Timestamp}. We recompute and compare in constant time; only
 * {@code ORDER_COMPLETED}/{@code ORDER_AUTHORISED} count as "settled". Anything that fails to verify or
 * parse yields {@link Optional#empty()} — the permit-listed endpoint then treats it as reject/ignore.
 *
 * <p>Confirmed against the Revolut Merchant API docs (developer.revolut.com). Exact API-version behaviour
 * and the settled-event set are the API-shape assumptions flagged for the post-deploy live smoke test.
 */
@Component
public class RevolutPaymentProvider implements PaymentProvider {

    private static final Logger log = LoggerFactory.getLogger(RevolutPaymentProvider.class);

    /** The provider identifier persisted on the order ({@code Order.provider}). */
    static final String PROVIDER_NAME = "revolut";

    /** The signature-algorithm version prefix Revolut uses in both the header and the signed payload. */
    private static final String SIGNATURE_VERSION = "v1";

    /**
     * Revolut order events that mean the money has settled and the RSVP may be confirmed. {@code COMPLETED}
     * is the terminal "paid" event for an auto-capture order; {@code AUTHORISED} covers an auth-then-capture
     * setup. Any other lifecycle event (declined/cancelled/failed/…) is not a confirm trigger.
     */
    private static final Set<String> SETTLED_EVENTS = Set.of("ORDER_COMPLETED", "ORDER_AUTHORISED");

    private final RevolutProperties props;
    private final ObjectMapper json;
    private final HttpClient http;

    @Autowired
    public RevolutPaymentProvider(RevolutProperties props, ObjectMapper json) {
        this(props, json, HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build());
    }

    /** Test seam: inject a client pointed at a loopback stub so the adapter is exercised with no live calls. */
    RevolutPaymentProvider(RevolutProperties props, ObjectMapper json, HttpClient http) {
        this.props = props;
        this.json = json;
        this.http = http;
    }

    @Override
    public String name() {
        return PROVIDER_NAME;
    }

    @Override
    public PaymentOrder createOrder(int amountMinor, String currency, String reference) {
        if (props.secretKey().isBlank()) {
            // Fail loud rather than fire an unauthenticated request. Unreachable while the membership flag
            // is off (checkout never hits the PAY branch), so this only guards a misconfigured live boot.
            throw new PaymentProviderException("Revolut secret key is not configured (REVOLUT_SECRET_KEY)");
        }
        // Amount in MINOR units (pence for GBP) — Order.amountPence is already minor, so pass it through.
        // merchant_order_ext_ref carries our local order id for reconciliation (the current Merchant API
        // field for a merchant reference); harmless if the account ignores it.
        String body;
        try {
            body = json.writeValueAsString(Map.of(
                    "amount", amountMinor,
                    "currency", currency,
                    "merchant_order_ext_ref", reference == null ? "" : reference));
        } catch (Exception e) {
            throw new PaymentProviderException("Failed to serialise Revolut create-order request", e);
        }

        HttpRequest request = HttpRequest.newBuilder(URI.create(props.apiBase() + "/api/orders"))
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + props.secretKey())
                .header("Revolut-Api-Version", props.apiVersion())
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (Exception e) {
            // Restore the interrupt flag if we were interrupted mid-call, then fail the transaction.
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new PaymentProviderException("Revolut create-order call failed", e);
        }

        if (response.statusCode() / 100 != 2) {
            // Never echo the provider body to the caller; log server-side for the smoke test / debugging.
            log.warn("Revolut create-order returned HTTP {}", response.statusCode());
            throw new PaymentProviderException("Revolut create-order returned HTTP " + response.statusCode());
        }

        try {
            JsonNode node = json.readTree(response.body());
            String id = node.path("id").asText(null);
            String token = node.path("token").asText(null);
            if (id == null || id.isBlank() || token == null || token.isBlank()) {
                throw new PaymentProviderException("Revolut create-order response missing id/token");
            }
            return new PaymentOrder(id, token);
        } catch (PaymentProviderException e) {
            throw e;
        } catch (Exception e) {
            throw new PaymentProviderException("Failed to parse Revolut create-order response", e);
        }
    }

    @Override
    public Optional<PaymentWebhookEvent> parseWebhookEvent(
            byte[] rawBody, String signatureHeader, String timestampHeader) {
        // Fail closed: no signing secret configured, or a missing signature/timestamp ⇒ we cannot trust it.
        if (props.webhookSigningSecret().isBlank()
                || signatureHeader == null
                || signatureHeader.isBlank()
                || timestampHeader == null
                || timestampHeader.isBlank()
                || rawBody == null) {
            return Optional.empty();
        }

        // payload_to_sign = "v1" + "." + timestamp + "." + raw_body (the raw bytes, unmodified).
        String payloadToSign =
                SIGNATURE_VERSION + "." + timestampHeader + "." + new String(rawBody, StandardCharsets.UTF_8);
        String expected = SIGNATURE_VERSION + "=" + hmacSha256Hex(props.webhookSigningSecret(), payloadToSign);

        // The header can carry multiple space/comma-separated signatures during a secret rotation; accept
        // if ANY matches. Constant-time comparison so a timing side-channel can't leak the expected value.
        boolean verified = false;
        for (String candidate : signatureHeader.split("[,\\s]+")) {
            if (!candidate.isBlank() && constantTimeEquals(expected, candidate.trim())) {
                verified = true;
                break;
            }
        }
        if (!verified) {
            log.warn("Rejecting Revolut webhook: signature did not verify");
            return Optional.empty();
        }

        try {
            JsonNode node = json.readTree(rawBody);
            String event = node.path("event").asText("").toUpperCase(Locale.ROOT);
            String orderId = node.path("order_id").asText(null);
            if (orderId == null || orderId.isBlank()) {
                return Optional.empty();
            }
            return Optional.of(new PaymentWebhookEvent(orderId, SETTLED_EVENTS.contains(event)));
        } catch (Exception e) {
            log.warn("Rejecting Revolut webhook: body did not parse");
            return Optional.empty();
        }
    }

    /** Lowercase hex HMAC-SHA256 of {@code data} keyed by {@code secret} — the Revolut signature primitive. */
    private static String hmacSha256Hex(String secret, String data) {
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
            // HmacSHA256 is a mandated JCE algorithm, so this never happens in practice.
            throw new PaymentProviderException("HMAC-SHA256 unavailable", e);
        }
    }

    /** Length-aware constant-time string comparison — no early-out on the first differing byte. */
    private static boolean constantTimeEquals(String a, String b) {
        byte[] x = a.getBytes(StandardCharsets.UTF_8);
        byte[] y = b.getBytes(StandardCharsets.UTF_8);
        if (x.length != y.length) {
            return false;
        }
        int diff = 0;
        for (int i = 0; i < x.length; i++) {
            diff |= x[i] ^ y[i];
        }
        return diff == 0;
    }
}
