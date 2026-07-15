// Loopback Revolut Merchant-API stub for the browser-e2e harness (TM-759).
//
// The membership PAY + Subscribe journeys (paid-rsvp.spec.mjs / subscribe.spec.mjs, TM-738) exercise the
// REAL RevolutPaymentProvider end to end — it really builds and sends the create-order / create-customer
// HTTP calls Revolut's Merchant API expects. Headless CI can't reach the real sandbox
// (https://sandbox-merchant.revolut.com), so this standalone node:http server stands in for it: the e2e
// backend is started with REVOLUT_API_BASE=http://127.0.0.1:<PORT> (see .github/workflows/e2e.yml) and
// every outbound Merchant-API call the provider makes lands here instead.
//
// It is deliberately dumb and DETERMINISTIC — no real payments, no external calls, no state that outlives
// the process beyond a monotonic counter for unique ids. It only has to return the minimal 2xx JSON the
// provider READS off each response (per RevolutPaymentProvider.java), so that create-order / create-customer
// succeed and hand the flow a provider order id. Settlement is NOT done here: the specs inject the signed
// settle webhook themselves (membership-webhook.mjs) straight to the backend, so this stub never calls the
// backend back — it purely answers the provider's outbound calls.
//
// Endpoints implemented (matching RevolutPaymentProvider exactly — see that file for the precise paths):
//   • GET  /health                                    — readiness probe for the e2e.yml wait loop (not Revolut)
//   • POST /api/orders                                — create order  → { id, token, state, ... }
//   • POST /api/customers                             — create customer → { id }
//   • POST /api/orders/{id}/cancel                    — void order (best-effort) → { id, state:"cancelled" }
//   • POST /api/orders/{id}/refund                    — refund order (best-effort) → { id, state:"completed" }
//   • POST /api/orders/{id}/payments                  — off-session MIT charge → { state:"completed" }
//   • GET  /api/customers/{id}/payment_methods        — saved methods → [ { id, saved_for, created_at } ]
//
// The provider requires `id` + `token` NON-BLANK on create-order (toPaymentOrder throws otherwise), and
// `id` NON-BLANK on create-customer — those are the only hard requirements; extra fields are ignored.

import { createServer } from "node:http";

const PORT = Number(process.env.REVOLUT_STUB_PORT || 9210);

// A monotonic counter → deterministic, per-call-unique ids. Deterministic across a run so a failure log is
// readable; unique per call so two orders in one run never collide (their provider_order_id is the webhook
// match key, so a collision would let one webhook settle the wrong order).
let seq = 0;
const nextId = (prefix) => `${prefix}_e2e_${String(++seq).padStart(6, "0")}`;

/** Read the whole request body as a UTF-8 string (bodies are small JSON or empty). */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/** Send a JSON response with the given status. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const method = req.method || "GET";
  // Strip any query string; the provider never appends one, but be defensive.
  const path = (req.url || "/").split("?")[0];

  // Drain the body even when we don't use it, so the socket doesn't stall.
  const raw = await readBody(req);

  // ── Readiness probe (NOT a Revolut endpoint) — the e2e.yml wait loop curls this. ─────────────────────
  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { status: "ok", service: "revolut-stub", served: seq });
    return;
  }

  // ── CREATE ORDER: POST /api/orders (event PAY checkout + subscribe first charge). The provider reads
  // `id` (persisted as provider_order_id — the webhook match key) and `token` (the client widget token);
  // BOTH must be non-blank or toPaymentOrder() throws. state is informational (the specs settle by webhook).
  if (method === "POST" && path === "/api/orders") {
    const id = nextId("ord");
    sendJson(res, 200, {
      id, // permanent order id → provider_order_id
      token: nextId("tok"), // temporary client widget token
      state: "pending",
      public_id: id,
    });
    return;
  }

  // ── CREATE CUSTOMER: POST /api/customers (subscribe path). The provider reads `id` (non-blank required).
  if (method === "POST" && path === "/api/customers") {
    sendJson(res, 200, { id: nextId("cust") });
    return;
  }

  // ── Order sub-resources: POST /api/orders/{id}/(cancel|refund|payments). Match with a regex so the id
  // segment is captured; the provider embeds the real provider order id there.
  const orderSub = path.match(/^\/api\/orders\/([^/]+)\/(cancel|refund|payments)$/);
  if (method === "POST" && orderSub) {
    const orderId = orderSub[1];
    const action = orderSub[2];
    if (action === "cancel") {
      // Body ignored by the provider (best-effort) — just a 2xx.
      sendJson(res, 200, { id: orderId, state: "cancelled" });
      return;
    }
    if (action === "refund") {
      // Body ignored by the provider (best-effort) — just a 2xx.
      sendJson(res, 200, { id: orderId, state: "completed" });
      return;
    }
    // action === "payments": off-session MIT renewal. The provider reads top-level `state` first, falling
    // back to payments[0].state; "completed" is a SETTLED state (SavedMethodCharge.fromState).
    sendJson(res, 200, { id: orderId, state: "completed" });
    return;
  }

  // ── LIST SAVED PAYMENT METHODS: GET /api/customers/{id}/payment_methods → a JSON ARRAY. Only
  // saved_for="MERCHANT" entries qualify; latest created_at wins. One MERCHANT method is enough.
  const methods = path.match(/^\/api\/customers\/([^/]+)\/payment_methods$/);
  if (method === "GET" && methods) {
    sendJson(res, 200, [
      { id: nextId("pm"), saved_for: "MERCHANT", created_at: new Date().toISOString() },
    ]);
    return;
  }

  // Anything else the provider doesn't call — 404 so an unexpected path surfaces loudly in the log.
  sendJson(res, 404, { error: "not_found", method, path });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e] revolut stub on http://127.0.0.1:${PORT} (deterministic loopback Merchant API)`);
});
