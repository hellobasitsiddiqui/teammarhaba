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
 * {@code ORDER_COMPLETED}/{@code ORDER_AUTHORISED} count as "settled", while
 * {@code ORDER_PAYMENT_DECLINED}/{@code ORDER_PAYMENT_FAILED} reduce to a terminal "failed" outcome
 * (TM-634) and every other event to "other". Anything that fails to verify or parse yields
 * {@link Optional#empty()} — the permit-listed endpoint then treats it as reject/ignore.
 *
 * <p><b>Subscriptions (TM-620)</b> — three more Merchant API calls power recurring billing:
 * {@code POST /api/customers} (the Customer a saved card attaches to), {@code POST /api/orders} with a
 * {@code customer.id} (an order the widget can save the card against / a renewal can charge through),
 * {@code POST /api/orders/{id}/payments} with {@code saved_payment_method.initiator=merchant} (the
 * off-session MIT renewal charge — no SCA challenge, per the merchant-initiated exemption anchored on
 * the SCA-authenticated first payment) and {@code GET /api/customers/{id}/payment_methods} (find the
 * MERCHANT-saved method).
 *
 * <p>Confirmed against the Revolut Merchant API docs (developer.revolut.com). Exact API-version behaviour,
 * the settled-event set, the customers/payment_methods endpoint paths and the pay-order response envelope
 * are the API-shape assumptions flagged for the post-deploy live smoke test.
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
     * setup. Any other lifecycle event that is not in {@link #FAILED_EVENTS} is not a confirm trigger.
     */
    private static final Set<String> SETTLED_EVENTS = Set.of("ORDER_COMPLETED", "ORDER_AUTHORISED");

    /**
     * Revolut order events that mean the INITIAL widget payment was declined/failed (TM-634). These drive
     * the local order to a terminal {@code FAILED} state (never a settle) so it stops sitting {@code PENDING}
     * forever — the money never captured, so nothing is owed back. Renewals are unaffected: an off-session
     * renewal decline is handled synchronously by {@code payWithSavedMethod}, not through this webhook.
     *
     * <p>Note (ops follow-up, not code): actually RECEIVING these deliveries requires the Revolut webhook
     * subscription to include {@code ORDER_PAYMENT_DECLINED}/{@code ORDER_PAYMENT_FAILED} in its event list
     * — re-register/patch the webhook on the dashboard so the events reach this endpoint.
     */
    private static final Set<String> FAILED_EVENTS = Set.of("ORDER_PAYMENT_DECLINED", "ORDER_PAYMENT_FAILED");

    /**
     * Replay window (TM-623): how far in the PAST a webhook's {@code Revolut-Request-Timestamp} may be
     * before the delivery is rejected as stale. The timestamp is inside the signed payload, so an
     * attacker can't forge a fresh one — but WITHOUT this check any captured signed delivery would verify
     * forever. 5 minutes matches Revolut's own guidance and absorbs normal clock skew + retry lag. The
     * check is PAST-ONLY (TM-871): future skew, where this server's clock runs behind Revolut's, is
     * tolerated so a genuine, correctly-signed settle is not rejected just because our clock drifted.
     */
    private static final Duration MAX_WEBHOOK_AGE = Duration.ofMinutes(5);

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
    public String currency() {
        // The configured app.payments.revolut.currency (GBP fallback, normalised by RevolutProperties).
        // Exposed through the seam (TM-629) so the checkout/renewal/refund services all charge in the
        // ONE configured currency instead of each hardcoding "GBP" and dead-lettering the config knob.
        return props.currency();
    }

    @Override
    public PaymentOrder createOrder(int amountMinor, String currency, String reference) {
        // Amount in MINOR units (pence for GBP) — Order.amountPence is already minor, so pass it through.
        // merchant_order_ext_ref carries our local order id for reconciliation (the current Merchant API
        // field for a merchant reference); harmless if the account ignores it.
        JsonNode node = postJson(
                "/api/orders",
                Map.of(
                        "amount", amountMinor,
                        "currency", currency,
                        "merchant_order_ext_ref", reference == null ? "" : reference),
                "create-order");
        return toPaymentOrder(node, "create-order");
    }

    @Override
    public String createCustomer(String email, String phone, String fullName) {
        // Register the account with Revolut so the widget's card-save has a Customer to attach the method
        // to (TM-620). Only non-blank fields are sent. The phone number is included (TM-623) because a
        // phone-only account — a mainline, supported sign-in path — has no email and often no display
        // name; without the phone the request body would be literally {} and the registration (and with
        // it the whole subscribe flow for those users) would hinge on Revolut accepting an anonymous
        // customer. Endpoint per the Merchant API customers reference:
        // POST {base}/api/customers {email, phone, full_name} → {id, …}.
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        if (email != null && !email.isBlank()) {
            body.put("email", email);
        }
        if (phone != null && !phone.isBlank()) {
            body.put("phone", phone);
        }
        if (fullName != null && !fullName.isBlank()) {
            body.put("full_name", fullName);
        }
        JsonNode node = postJson("/api/customers", body, "create-customer");
        String id = node.path("id").asText(null);
        if (id == null || id.isBlank()) {
            throw new PaymentProviderException("Revolut create-customer response missing id");
        }
        return id;
    }

    @Override
    public void cancelOrder(String providerOrderId) {
        // Void an unpaid order (TM-623): POST /api/orders/{id}/cancel per the Merchant API reference.
        // Called best-effort when the local flow abandons an order (a re-pointed Subscribe checkout, a
        // cancelled PENDING PAY order) so its still-live widget token can no longer capture money that
        // would reconcile to nothing. A cancel of an already-completed order is refused by Revolut —
        // the caller logs and moves on (the settle webhook then handles the completed payment).
        postJson("/api/orders/" + providerOrderId + "/cancel", Map.of(), "cancel-order");
    }

    @Override
    public void refund(String providerOrderId, int amountMinor, String currency, String reference) {
        // Return captured money (TM-623): POST /api/orders/{id}/refund with the minor-unit amount, per
        // the Merchant API refund reference. Drives OrderStatus.REFUND_DUE — the state that previously
        // had no execution path at all. A non-2xx (already refunded, too late, wrong amount) throws and
        // the order stays REFUND_DUE, keeping the debt visible and retryable.
        postJson(
                "/api/orders/" + providerOrderId + "/refund",
                Map.of(
                        "amount", amountMinor,
                        "currency", currency,
                        "merchant_order_ext_ref", reference == null ? "" : reference),
                "refund-order");
    }

    @Override
    public PaymentOrder createOrderForCustomer(int amountMinor, String currency, String reference, String customerId) {
        // Same create-order call as the event checkout, plus the customer the order (and any card the
        // widget saves against it) belongs to: {customer: {id}} per the Merchant API create-order shape.
        JsonNode node = postJson(
                "/api/orders",
                Map.of(
                        "amount", amountMinor,
                        "currency", currency,
                        "merchant_order_ext_ref", reference == null ? "" : reference,
                        "customer", Map.of("id", customerId)),
                "create-order");
        return toPaymentOrder(node, "create-order");
    }

    @Override
    public SavedMethodCharge payWithSavedMethod(String providerOrderId, String paymentMethodId) {
        // The off-session MIT charge (TM-620): POST /api/orders/{id}/payments with the saved method and
        // initiator=merchant, per the Merchant API "Pay for an order" reference. No SCA challenge runs —
        // the mandate was SCA-authenticated on the first in-browser payment, and initiator=merchant tells
        // the issuer to apply the merchant-initiated exemption. The response's state settles synchronously.
        JsonNode node = postJson(
                "/api/orders/" + providerOrderId + "/payments",
                Map.of(
                        "saved_payment_method",
                        Map.of(
                                "type", "card",
                                "id", paymentMethodId,
                                "initiator", "merchant")),
                "pay-order");
        // The payment state may sit at the top level or (per some API versions) under `payments[0]`;
        // read the top-level `state` first and fall back — the exact envelope is a smoke-test assumption.
        String state = node.path("state").asText(null);
        if (state == null || state.isBlank()) {
            state = node.path("payments").path(0).path("state").asText("");
        }
        return SavedMethodCharge.fromState(state);
    }

    @Override
    public Optional<String> findMerchantSavedPaymentMethod(String customerId) {
        // GET /api/customers/{id}/payment_methods → the customer's saved methods; only one saved with
        // saved_for=MERCHANT can be charged off-session (the widget's savePaymentMethodFor:"merchant"
        // save). "Most recently saved wins" after a re-subscribe: prefer the entry with the LATEST
        // created_at when the field is present (ISO-8601 sorts lexicographically), falling back to array
        // position — response ordering alone is an undocumented assumption (TM-623), and picking an old
        // entry could charge an expired card while a fresh one sits saved.
        JsonNode node = getJson("/api/customers/" + customerId + "/payment_methods", "list-payment-methods");
        String found = null;
        String foundCreatedAt = null;
        if (node.isArray()) {
            for (JsonNode method : node) {
                String savedFor = method.path("saved_for").asText("").toUpperCase(Locale.ROOT);
                String id = method.path("id").asText(null);
                if (!"MERCHANT".equals(savedFor) || id == null || id.isBlank()) {
                    continue;
                }
                String createdAt = method.path("created_at").asText("");
                // Later created_at wins; equal/absent timestamps keep the old "later array entry wins".
                if (found == null || createdAt.compareTo(foundCreatedAt) >= 0) {
                    found = id;
                    foundCreatedAt = createdAt;
                }
            }
        }
        return Optional.ofNullable(found);
    }

    // ------------------------------------------------------------------ shared HTTP plumbing

    /** Reduce a create-order response to the permanent id + client token, failing loudly when malformed. */
    private static PaymentOrder toPaymentOrder(JsonNode node, String operation) {
        String id = node.path("id").asText(null);
        String token = node.path("token").asText(null);
        if (id == null || id.isBlank() || token == null || token.isBlank()) {
            throw new PaymentProviderException("Revolut " + operation + " response missing id/token");
        }
        return new PaymentOrder(id, token);
    }

    /** POST {@code body} as JSON to {@code path} on the Merchant API and parse the JSON response. */
    private JsonNode postJson(String path, Map<String, ?> body, String operation) {
        String payload;
        try {
            payload = json.writeValueAsString(body);
        } catch (Exception e) {
            throw new PaymentProviderException("Failed to serialise Revolut " + operation + " request", e);
        }
        return send(
                authorisedRequest(path).POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8)),
                operation);
    }

    /** GET {@code path} on the Merchant API and parse the JSON response. */
    private JsonNode getJson(String path, String operation) {
        return send(authorisedRequest(path).GET(), operation);
    }

    /**
     * The common request scaffold every Merchant API call shares: the Secret key as a Bearer token, the
     * dated {@code Revolut-Api-Version} header and JSON content negotiation. Fails loudly (rather than
     * firing an unauthenticated request) when no secret key is configured — the money paths are gated by
     * the SERVER-SIDE membership flag (TM-623), so this guards a misconfigured live boot after the flag
     * flips (the web-only flag never actually made these calls unreachable).
     */
    private HttpRequest.Builder authorisedRequest(String path) {
        if (props.secretKey().isBlank()) {
            throw new PaymentProviderException("Revolut secret key is not configured (REVOLUT_SECRET_KEY)");
        }
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(props.apiBase() + path))
                .timeout(Duration.ofSeconds(15))
                .header("Revolut-Api-Version", props.apiVersion())
                .header("Content-Type", "application/json")
                .header("Accept", "application/json");
        // Set Authorization LAST and on its own so a malformed key can never leak (TM-637). The key is
        // stripped at the config boundary (RevolutProperties), so the trailing-newline case that broke
        // every call is gone — but if a key somehow still carries an invalid header character, the JDK's
        // IllegalArgumentException embeds the offending value ("Bearer sk_…") VERBATIM, which would spill
        // the Secret key straight into Cloud Logging. Catch it and rethrow a redacted message with NO
        // cause attached, so neither the message nor any nested stack trace can contain the secret.
        try {
            builder.header("Authorization", "Bearer " + props.secretKey());
        } catch (IllegalArgumentException e) {
            throw new PaymentProviderException(
                    "Revolut secret key is malformed and cannot be used as an Authorization header "
                            + "(check REVOLUT_SECRET_KEY for stray characters)");
        }
        return builder;
    }

    /** Send the request, mapping transport failures and non-2xx statuses to {@link PaymentProviderException}. */
    private JsonNode send(HttpRequest.Builder request, String operation) {
        HttpResponse<String> response;
        try {
            response = http.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (Exception e) {
            // Restore the interrupt flag if we were interrupted mid-call, then fail the transaction.
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new PaymentProviderException("Revolut " + operation + " call failed", e);
        }

        if (response.statusCode() / 100 != 2) {
            // Never echo the provider body to the caller; log server-side for the smoke test / debugging.
            log.warn("Revolut {} returned HTTP {}", operation, response.statusCode());
            throw new PaymentProviderException("Revolut " + operation + " returned HTTP " + response.statusCode());
        }

        try {
            return json.readTree(response.body());
        } catch (Exception e) {
            throw new PaymentProviderException("Failed to parse Revolut " + operation + " response", e);
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

        // Freshness (TM-623), checked AFTER the signature so only authentic-but-stale deliveries are
        // measured: a replayed capture of a genuine delivery must not stay valid forever. The header is
        // epoch MILLISECONDS per the Revolut docs; a 10-digit value is tolerated as epoch seconds so a
        // unit mismatch fails safe (rejected as stale) rather than wildly misreading the age.
        long timestampMs;
        try {
            timestampMs = Long.parseLong(timestampHeader.trim());
        } catch (NumberFormatException e) {
            log.warn("Rejecting Revolut webhook: timestamp header did not parse");
            return Optional.empty();
        }
        if (timestampMs < 100_000_000_000L) {
            timestampMs *= 1000; // looks like epoch seconds — normalise to milliseconds
        }
        // Past-only staleness check (TM-871): reject only when the delivery is too OLD. The replay concern
        // is about PAST deliveries — a captured signed delivery must not stay valid forever — so we reject
        // when it is older than the window. FUTURE skew (this server's clock running BEHIND Revolut's) must
        // be TOLERATED: a Math.abs() check rejected a future-skewed-but-genuine settle exactly like a stale
        // one, so a >~5min-behind clock 401'd correctly-signed settles until, after retries, a paid order
        // sat PENDING (money captured, no RSVP). Not-yet-in-the-future deliveries verify normally.
        if (System.currentTimeMillis() - timestampMs > MAX_WEBHOOK_AGE.toMillis()) {
            log.warn("Rejecting Revolut webhook: timestamp older than the {} replay window", MAX_WEBHOOK_AGE);
            return Optional.empty();
        }

        try {
            JsonNode node = json.readTree(rawBody);
            String event = node.path("event").asText("").toUpperCase(Locale.ROOT);
            String orderId = node.path("order_id").asText(null);
            if (orderId == null || orderId.isBlank()) {
                return Optional.empty();
            }
            // Reduce the provider's event zoo to the three outcomes the confirm/fail path acts on (TM-634):
            // a settle, a decline/fail (terminal, non-settling), or any other lifecycle event we only ack.
            PaymentWebhookEvent.Outcome outcome;
            if (SETTLED_EVENTS.contains(event)) {
                outcome = PaymentWebhookEvent.Outcome.SETTLED;
            } else if (FAILED_EVENTS.contains(event)) {
                outcome = PaymentWebhookEvent.Outcome.FAILED;
            } else {
                outcome = PaymentWebhookEvent.Outcome.OTHER;
            }
            return Optional.of(new PaymentWebhookEvent(orderId, outcome));
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
