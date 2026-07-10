// Tests for the my-tickets/purchases + receipts pure core (TM-481). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The screen's decisions all live in DOM-free, api-free functions (the AC's "pure parts tested"): status
// presentation, money + date formatting, order normalisation + newest-first sort, and the receipt line
// list. `loadOrders` is exercised against a MOCK api (contract TM-457: the frontend resolves api at
// runtime, tests mock it) so we can assert it fetches + normalises with no browser and no network.
//
// It imports membership-receipts.js directly — safe under Node because that module imports only ui.js
// (never api.js → the Firebase CDN, which Node can't load; see the module header for why api is read off
// window.tmApi at runtime instead).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ORDER_STATUS,
  statusMeta,
  formatAmount,
  amountLabel,
  formatOrderDate,
  normalizeOrder,
  normalizeOrders,
  receiptLines,
  loadOrders,
} from "../src/assets/membership-receipts.js";

// --- status presentation -------------------------------------------------------------------------

test("statusMeta: each order state maps to a label + tone; unknown is defensive", () => {
  assert.deepEqual(statusMeta(ORDER_STATUS.PENDING), { label: "Awaiting payment", tone: "pending" });
  assert.deepEqual(statusMeta(ORDER_STATUS.CONFIRMED), { label: "Confirmed", tone: "confirmed" });
  assert.deepEqual(statusMeta(ORDER_STATUS.CANCELLED), { label: "Cancelled", tone: "cancelled" });
  assert.deepEqual(statusMeta(ORDER_STATUS.REFUND_DUE), { label: "Refund due", tone: "refund" });
  // An unknown / absent status never breaks the screen.
  assert.deepEqual(statusMeta("WAT"), { label: "Unknown", tone: "unknown" });
  assert.deepEqual(statusMeta(undefined), { label: "Unknown", tone: "unknown" });
});

// --- money ---------------------------------------------------------------------------------------

test("formatAmount: whole pounds without decimals, part-pounds to 2dp", () => {
  assert.equal(formatAmount(500), "£5");
  assert.equal(formatAmount(1500), "£15");
  assert.equal(formatAmount(250), "£2.50");
  assert.equal(formatAmount(99), "£0.99");
  assert.equal(formatAmount(0), "£0");
});

test("formatAmount: non-finite / negative inputs render as £0, never throw", () => {
  assert.equal(formatAmount(undefined), "£0");
  assert.equal(formatAmount(null), "£0");
  assert.equal(formatAmount(-500), "£0");
  assert.equal(formatAmount(Number.NaN), "£0");
});

test("amountLabel: a £0 order reads Free; any charge reads its money value", () => {
  assert.equal(amountLabel(0), "Free");
  assert.equal(amountLabel(-1), "Free");
  assert.equal(amountLabel(undefined), "Free");
  assert.equal(amountLabel(500), "£5");
  assert.equal(amountLabel(250), "£2.50");
});

// --- dates ---------------------------------------------------------------------------------------

test("formatOrderDate: an ISO instant renders as a short UTC date; junk renders empty", () => {
  assert.equal(formatOrderDate("2026-07-10T15:30:00Z"), "10 Jul 2026");
  assert.equal(formatOrderDate("2026-01-01T00:00:00Z"), "1 Jan 2026");
  assert.equal(formatOrderDate(null), "");
  assert.equal(formatOrderDate(undefined), "");
  assert.equal(formatOrderDate("not-a-date"), "");
});

// --- order normalisation -------------------------------------------------------------------------

test("normalizeOrder: coerces a raw order to a safe shape", () => {
  assert.deepEqual(
    normalizeOrder({ id: 7, eventId: 3, amountPence: 500, status: "CONFIRMED", createdAt: "2026-07-10T00:00:00Z" }),
    { id: 7, eventId: 3, amountPence: 500, status: "CONFIRMED", createdAt: "2026-07-10T00:00:00Z" },
  );
  // Defaults: missing ids → null, bad/negative amount → 0, non-string status → "", missing createdAt → null.
  assert.deepEqual(normalizeOrder({ amountPence: -5 }), {
    id: null,
    eventId: null,
    amountPence: 0,
    status: "",
    createdAt: null,
  });
  assert.equal(normalizeOrder({ amountPence: 12.9 }).amountPence, 12); // truncated to an integer pence
  assert.doesNotThrow(() => normalizeOrder(undefined));
});

test("normalizeOrders: non-array → []; sorts newest-first by createdAt then id", () => {
  assert.deepEqual(normalizeOrders(null), []);
  assert.deepEqual(normalizeOrders(undefined), []);

  const sorted = normalizeOrders([
    { id: 1, createdAt: "2026-07-01T00:00:00Z", status: "CONFIRMED", amountPence: 0 },
    { id: 3, createdAt: "2026-07-10T00:00:00Z", status: "PENDING", amountPence: 500 },
    { id: 2, createdAt: "2026-07-05T00:00:00Z", status: "CONFIRMED", amountPence: 0 },
  ]);
  assert.deepEqual(sorted.map((o) => o.id), [3, 2, 1], "newest createdAt first");
});

test("normalizeOrders: equal createdAt falls back to higher (later) id first", () => {
  const sorted = normalizeOrders([
    { id: 10, createdAt: "2026-07-10T00:00:00Z" },
    { id: 12, createdAt: "2026-07-10T00:00:00Z" },
    { id: 11, createdAt: "2026-07-10T00:00:00Z" },
  ]);
  assert.deepEqual(sorted.map((o) => o.id), [12, 11, 10]);
});

// --- receipt lines -------------------------------------------------------------------------------

test("receiptLines: the label/value rows a receipt shows for one order", () => {
  const lines = receiptLines({
    id: 42,
    eventId: 7,
    amountPence: 500,
    status: "CONFIRMED",
    createdAt: "2026-07-10T09:00:00Z",
  });
  assert.deepEqual(lines, [
    { label: "Order", value: "#42" },
    { label: "Event", value: "#7" },
    { label: "Amount", value: "£5" },
    { label: "Status", value: "Confirmed" },
    { label: "Date", value: "10 Jul 2026" },
  ]);
});

test("receiptLines: a £0 order reads Free and a missing date is omitted", () => {
  const lines = receiptLines({ id: 1, eventId: 2, amountPence: 0, status: "CANCELLED", createdAt: null });
  assert.deepEqual(lines, [
    { label: "Order", value: "#1" },
    { label: "Event", value: "#2" },
    { label: "Amount", value: "Free" },
    { label: "Status", value: "Cancelled" },
  ]);
  assert.equal(lines.find((l) => l.label === "Date"), undefined, "no Date row when createdAt is absent");
});

// --- loadOrders against a mock api ---------------------------------------------------------------

test("loadOrders: calls api.getMyOrders and returns the normalised, newest-first list", async () => {
  let calls = 0;
  const api = {
    getMyOrders: async () => {
      calls += 1;
      return [
        { id: 1, eventId: 1, amountPence: 0, status: "CONFIRMED", createdAt: "2026-07-01T00:00:00Z" },
        { id: 2, eventId: 2, amountPence: 500, status: "PENDING", createdAt: "2026-07-09T00:00:00Z" },
      ];
    },
  };
  const orders = await loadOrders(api);
  assert.equal(calls, 1, "hit the endpoint exactly once");
  assert.deepEqual(orders.map((o) => o.id), [2, 1], "newest-first");
  assert.equal(orders[0].status, "PENDING");
});

test("loadOrders: a missing getMyOrders (older api bridge) yields [] rather than throwing", async () => {
  assert.deepEqual(await loadOrders({}), []);
  assert.deepEqual(await loadOrders(undefined), []);
});

test("loadOrders: a network error propagates so the caller can show the error state", async () => {
  const boom = new Error("network down");
  const api = {
    getMyOrders: async () => {
      throw boom;
    },
  };
  await assert.rejects(() => loadOrders(api), boom);
});
