// First-party payment-webhook + order helpers for the membership/checkout e2e (TM-738).
//
// The membership PAY + Subscribe journeys both finish the SAME way production does: the browser opens a
// checkout (which records a PENDING order/charge server-side and mounts the Revolut card WIDGET), and the
// commitment is only ever CONFIRMED/ACTIVATED by a VERIFIED settle webhook Revolut posts back — never by
// the client claiming success. Headless CI has no real Revolut and no real card, so this module supplies
// the missing half deterministically:
//
//   • it INJECTS the settle webhook the way Revolut would — POST /api/v1/payments/revolut/webhook with a
//     genuine `Revolut-Signature: v1=<hmac>` computed over the exact signed payload, so the REAL
//     RevolutPaymentProvider.parseWebhookEvent verifies it end to end (no verification is bypassed);
//   • it reads the provider order id the stub minted for the caller's order/charge straight from Postgres
//     (the same DB seam the specs assert on), because that id is the webhook match key and the client
//     checkout response never exposes it.
//
// This mirrors events-api.mjs / chat-seed.mjs: choreography with NO user-facing UI is done as first-party
// calls, not driven through the browser. Everything here is emulator/loopback only — no real payment, no
// real SMS/email, no secrets in the transcript. The signing secret is the e2e-only value the harness
// configures on the backend (REVOLUT_WEBHOOK_SIGNING_SECRET), read from the environment so the HMAC the
// spec computes matches the one the backend recomputes.
//
// ── Harness requirements (set by the integrator in .github/workflows/e2e.yml's backend env, NOT here) ──
// The membership money paths ship behind an OFF server-side flag and need a payment provider, so the
// e2e backend must be started with:
//     MEMBERSHIP_ENABLED=true                     # server-side kill switch ON (MembershipProperties)
//     SUBSCRIPTIONS_ENABLED=false                 # renewal scheduler bean stays OFF (we drive the initial
//                                                 #   charge by webhook; no background renewals mid-suite)
//     REVOLUT_SECRET_KEY=e2e-secret               # any non-blank value — RevolutPaymentProvider refuses to
//                                                 #   fire an unauthenticated create-order when this is blank
//     REVOLUT_API_BASE=http://127.0.0.1:<stub>    # a LOOPBACK Revolut stub (serve.mjs-style) whose
//                                                 #   POST /api/orders + /api/customers return {id, token}
//                                                 #   — so create-order/customer succeed with NO real call
//     REVOLUT_WEBHOOK_SIGNING_SECRET=<value>      # the SAME value E2E_REVOLUT_WEBHOOK_SIGNING_SECRET below
// The WEB side (the widget) is stubbed per-spec by pre-seeding window.RevolutCheckout (see the specs) so
// membership-checkout.js's SDK loader short-circuits on the present global and injects no external <script>
// (the strict-CSP hermetic env blocks the sandbox CDN anyway).

import { createHmac } from "node:crypto";
import pg from "pg";
import { API_BASE_URL, dbConfig } from "./fixtures.mjs";

/** The webhook endpoint (permit-listed but signature-guarded — the caller is Revolut, not a user). */
const WEBHOOK_PATH = "/api/v1/payments/revolut/webhook";

/** The signature-algorithm version prefix Revolut (and RevolutPaymentProvider) use. */
const SIGNATURE_VERSION = "v1";

/**
 * The webhook signing secret the e2e backend is configured with (REVOLUT_WEBHOOK_SIGNING_SECRET). The
 * spec computes the HMAC with THIS value and the backend recomputes it with the same value, so the
 * injected delivery verifies for real. Falls back to a fixed harness default so a local run needs only
 * to set the ONE env on the backend to the same string; CI passes it explicitly on both sides.
 */
export const E2E_REVOLUT_WEBHOOK_SIGNING_SECRET =
  process.env.E2E_REVOLUT_WEBHOOK_SIGNING_SECRET ||
  process.env.REVOLUT_WEBHOOK_SIGNING_SECRET ||
  "e2e-revolut-webhook-signing-secret";

/**
 * Post a signed Revolut order webhook to the backend, exactly as Revolut would (TM-478). Builds the raw
 * JSON body, signs `"v1." + timestamp + "." + rawBody` with HMAC-SHA256 (the RevolutPaymentProvider
 * primitive), and sends it with the `Revolut-Signature` + `Revolut-Request-Timestamp` headers. A settle
 * event (`ORDER_COMPLETED`) is the one the confirm/activate path acts on.
 *
 * The backend answers 200 when the signature verifies (whether or not it matched a local ledger) and 401
 * when it cannot be trusted — so a 200 proves the injection was ACCEPTED, and the follow-up DB/API assert
 * proves it CONFIRMED the right order. Uses a fresh epoch-millis timestamp each call so it sits inside the
 * 5-minute replay window (TM-623).
 *
 * @param {string} providerOrderId the provider order id the stub minted (the webhook match key)
 * @param {string} [event] the Revolut order event (default ORDER_COMPLETED — a settle)
 * @returns {Promise<Response>} the fetch Response (status 200 = verified/accepted)
 */
export async function injectSettleWebhook(providerOrderId, event = "ORDER_COMPLETED") {
  // The provider reads `order_id` + `event` off the parsed body; the exact byte string is what's signed.
  const rawBody = JSON.stringify({ event, order_id: providerOrderId });
  const timestamp = String(Date.now()); // epoch millis — inside the replay window
  const payloadToSign = `${SIGNATURE_VERSION}.${timestamp}.${rawBody}`;
  const hmacHex = createHmac("sha256", E2E_REVOLUT_WEBHOOK_SIGNING_SECRET).update(payloadToSign).digest("hex");

  const res = await fetch(`${API_BASE_URL}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Revolut-Signature": `${SIGNATURE_VERSION}=${hmacHex}`,
      "Revolut-Request-Timestamp": timestamp,
    },
    body: rawBody,
  });
  return res;
}

/** Open a connected pg client against the same Postgres the stack uses. Caller must `end()` it. */
async function client() {
  const c = new pg.Client(dbConfig);
  await c.connect();
  return c;
}

/**
 * Read the provider order id + status of the caller's PAY order for one event, straight from Postgres —
 * the webhook match key the client checkout response never exposes. Polled by the spec until the checkout
 * POST has committed the PENDING row (the widget mount is async), so it never races the create-order.
 *
 * @param {number|string} eventId the event the order is for
 * @param {string} email the caller's email (orders join users by id)
 * @returns {Promise<{providerOrderId: string|null, status: string}|null>} the row, or null if none yet
 */
export async function readOrderForEvent(eventId, email) {
  const c = await client();
  try {
    const { rows } = await c.query(
      `SELECT o.provider_order_id AS "providerOrderId", o.status
         FROM orders o
         JOIN users u ON u.id = o.user_id
        WHERE o.event_id = $1 AND lower(u.email) = lower($2)`,
      [eventId, email],
    );
    return rows[0] || null;
  } finally {
    await c.end();
  }
}

/**
 * Read the provider order id + status of the caller's INITIAL, still-PENDING subscription charge — the
 * match key for the subscribe settle webhook. Newest-first so a re-subscribe (which opens a fresh INITIAL
 * row and freezes the old one) always resolves to the attempt just started.
 *
 * @param {string} email the caller's email
 * @returns {Promise<{providerOrderId: string|null, status: string}|null>} the row, or null if none yet
 */
export async function readPendingInitialCharge(email) {
  const c = await client();
  try {
    const { rows } = await c.query(
      `SELECT sc.provider_order_id AS "providerOrderId", sc.status
         FROM subscription_charges sc
         JOIN users u ON u.id = sc.user_id
        WHERE lower(u.email) = lower($1)
          AND sc.kind = 'INITIAL'
          AND sc.status = 'PENDING'
        ORDER BY sc.created_at DESC, sc.id DESC
        LIMIT 1`,
      [email],
    );
    return rows[0] || null;
  } finally {
    await c.end();
  }
}

/**
 * Clean slate for the paid-RSVP account (TM-738): drop any attendance + order rows on the given event, so
 * the spec always starts from a fresh PAY checkout regardless of a prior run / CI retry. A lingering
 * CONFIRMED order (idempotency key is UNIQUE(user_id, event_id)) would otherwise make the re-checkout an
 * idempotent no-op and never re-open the PENDING → CONFIRMED transition the test asserts. Best-effort.
 *
 * @param {string} email the account's email
 */
export async function resetOrdersFor(email) {
  const c = await client();
  try {
    await c.query(
      `DELETE FROM orders
        WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
      [email],
    );
    await c.query(
      `DELETE FROM event_attendance
        WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
      [email],
    );
  } finally {
    await c.end();
  }
}

/**
 * Clean slate for the subscriber account (TM-738): drop its subscription + all charge rows, so the spec
 * always starts unsubscribed. A leftover ACTIVE subscription from a prior run would make the Subscribe
 * checkout 409 (already actively subscribed), so this keeps the journey idempotent across CI retries.
 * Charges are deleted first (they're keyed by user_id, not a subscription FK, so they survive an ON DELETE
 * of the subscription row) then the subscription. Best-effort.
 *
 * @param {string} email the account's email
 */
export async function resetSubscriptionFor(email) {
  const c = await client();
  try {
    await c.query(
      `DELETE FROM subscription_charges
        WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
      [email],
    );
    await c.query(
      `DELETE FROM subscriptions
        WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
      [email],
    );
  } finally {
    await c.end();
  }
}
