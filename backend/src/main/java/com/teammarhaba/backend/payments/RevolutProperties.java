package com.teammarhaba.backend.payments;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Configuration for the Revolut Merchant API payment integration (TM-478), bound from
 * {@code app.payments.revolut.*} and picked up by the app-wide {@code @ConfigurationPropertiesScan}
 * (see {@code Application}). Sandbox-first: the whole membership paid path ships behind the OFF
 * {@code membership} flag, so <em>every</em> value here is optional and defaults to a blank/sandbox
 * value — a prod boot with the flag off never needs a real key, and a missing secret must never fail
 * startup (the deploy wires the secret only when it exists — see {@code deploy.yml}'s gated step).
 *
 * <ul>
 *   <li>{@code secretKey} — the Merchant API <b>Secret</b> key ({@code sk_…}); the server-side bearer
 *       token for create-order. Sourced from {@code REVOLUT_SECRET_KEY} (Secret Manager in prod). Blank
 *       when unset — {@link RevolutPaymentProvider#createOrder} then fails loudly if it is ever called
 *       (it never is while the flag is off), rather than silently issuing an unauthenticated request.</li>
 *   <li>{@code apiBase} — the Merchant API base URL. Defaults to the sandbox base
 *       {@code https://sandbox-merchant.revolut.com}; go-live swaps it (and the keys) for
 *       {@code https://merchant.revolut.com}.</li>
 *   <li>{@code apiVersion} — the dated {@code Revolut-Api-Version} header (YYYY-MM-DD). The create-order
 *       request/response shape ({@code {amount,currency}} → {@code {id,token,state}}) is stable across
 *       the recent versions; pinned via config so it can be bumped without a code change.</li>
 *   <li>{@code webhookSigningSecret} — the secret Revolut signs webhook payloads with (generated when the
 *       webhook is created on the Revolut dashboard, NOT the same as the API secret key). Used to verify
 *       the {@code Revolut-Signature} HMAC. Blank when unset → every webhook is rejected (fail-closed).</li>
 *   <li>{@code currency} — the ISO-4217 currency the £5 ticket path charges in. Defaults to {@code GBP}.</li>
 * </ul>
 *
 * @param secretKey            Merchant API Secret key (bearer); blank when unconfigured
 * @param apiBase              Merchant API base URL (sandbox by default)
 * @param apiVersion           the {@code Revolut-Api-Version} header value (YYYY-MM-DD)
 * @param webhookSigningSecret webhook payload signing secret; blank when unconfigured (webhooks rejected)
 * @param currency            ISO-4217 currency code for the charge
 */
@ConfigurationProperties(prefix = "app.payments.revolut")
public record RevolutProperties(
        String secretKey, String apiBase, String apiVersion, String webhookSigningSecret, String currency) {

    /**
     * Normalises the optional/defaultable fields so the provider never has to null-check them: a blank
     * {@code apiBase}/{@code apiVersion}/{@code currency} falls back to the sandbox/stable default, and a
     * trailing slash on the base is trimmed so path-joining is unambiguous. Secrets are left exactly as
     * supplied (blank stays blank — the callers treat blank as "not configured" and fail closed).
     */
    public RevolutProperties {
        apiBase = blankTo(apiBase, "https://sandbox-merchant.revolut.com");
        if (apiBase.endsWith("/")) {
            apiBase = apiBase.substring(0, apiBase.length() - 1);
        }
        apiVersion = blankTo(apiVersion, "2024-09-01");
        currency = blankTo(currency, "GBP");
        secretKey = secretKey == null ? "" : secretKey;
        webhookSigningSecret = webhookSigningSecret == null ? "" : webhookSigningSecret;
    }

    private static String blankTo(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    /**
     * Secrets never in text form (TM-623): a record's generated {@code toString} would print the API
     * secret key and the webhook signing secret verbatim, so any incautious log/debug/error message
     * carrying this object would leak live credentials. Both are masked to presence-only.
     */
    @Override
    public String toString() {
        return "RevolutProperties{apiBase=" + apiBase
                + ", apiVersion=" + apiVersion
                + ", currency=" + currency
                + ", secretKey=" + mask(secretKey)
                + ", webhookSigningSecret=" + mask(webhookSigningSecret)
                + "}";
    }

    /** Presence-only rendering of a secret: never the value, just whether one is configured. */
    private static String mask(String secret) {
        return secret == null || secret.isBlank() ? "(unset)" : "***";
    }
}
