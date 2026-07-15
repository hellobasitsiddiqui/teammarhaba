// My tickets / purchases + receipts (TM-481) — the caller's order history + a per-order receipt view.
//
// Part of the Membership slice (contract TM-457, epic group-membership). This screen lists the caller's
// checkout orders (M4 / TM-477) — event, amount, status and when it was placed — newest-first, and lets
// them open a simple receipt for any one order. Backed by the API TM-481 adds:
//   GET /api/v1/me/orders -> [ { id, eventId, amountPence, status, createdAt }, ... ] newest-first.
// TM-481 shipped this screen with its OWN hashchange listener + nav reveal (self-managed lifecycle).
// TM-624 folded that routing into router.js — the app router now owns #/receipts' show/hide, its auth
// guard, mount-once lifecycle and the nav reveal (exactly the TM-606 pattern the tier screen uses) —
// because the self-managed version double-rendered against the router and ignored the signed-out /
// onboarding-gated states every other screen respects. This module now exposes the pure helpers below
// plus enterMembershipReceipts() (the router entry) and no longer touches window/hashchange itself.
//
// WHY the api namespace is read at RUNTIME off `window.tmApi` rather than a static `import * as api from
// "./api.js"` — the same rationale as the sibling membership-tier.js (contract TM-457):
//   • api is treated as a NAMESPACE whose members are resolved at CALL time, never a named import of a
//     symbol that could be a missing export on a partly-landed branch (an ESM link error white-screens
//     the whole boot graph). `getApi().getMyOrders` is simply undefined until it exists, resolved when
//     the screen actually runs.
//   • api.js is not importable under Node (it transitively imports the Firebase SDK over an https URL,
//     which Node's ESM loader rejects). A static import of it would make THIS file impossible to load in
//     the mandated `node --test web/tools/*.test.mjs` gate — so, exactly like membership-tier.js, we read
//     the `window.tmApi` bridge api.js already publishes ("Bridge for the framework-free page") at call
//     time. The test imports this module directly and exercises the pure helpers + `loadOrders` against a
//     MOCK api object, so no network/DOM is involved there.
//
// The whole screen is gated behind `config.flags.membership` (READ only — TM-480 owns the flag and ships
// it OFF). With the flag off router.js never treats #/receipts as a known route and never calls
// enterMembershipReceipts(), so the screen stays inert dead code until the flag flips.
//
// DESIGN: every decision (status labels, money + date formatting, order normalisation/sorting, the
// receipt line list) lives in the PURE, DOM-free, api-free functions exported below and is exhaustively
// unit-tested (the AC's "pure parts tested"). The DOM half only paints what those functions decide, via
// ui.js's XSS-safe el() (textContent only, never innerHTML), using theme tokens so it renders correctly
// under Paper + the per-user accent / sketchy toggle (TM-529).

import { el, clear } from "./ui.js";

// --- Status ---------------------------------------------------------------------------------------

/** The order lifecycle states the endpoint can return (mirrors the backend OrderStatus enum). */
export const ORDER_STATUS = Object.freeze({
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
  REFUND_DUE: "REFUND_DUE",
  REFUNDED: "REFUNDED", // TM-623: the owed refund was issued at the provider — terminal
  // TM-726: the sweep retried the owed refund up to its cap and it kept failing — terminal for the sweep,
  // the money is still owed and needs a human to reconcile (distinct from REFUNDED, where it came back).
  REFUND_ABANDONED: "REFUND_ABANDONED",
  FAILED: "FAILED", // TM-634: the INITIAL widget payment was declined/failed — terminal, never captured
  EXPIRED: "EXPIRED", // TM-634: an abandoned PENDING order the TTL sweep retired — terminal, never captured
});

/**
 * Human presentation for an order status: a `label` for the badge and a `tone` the CSS colours by
 * (a calm "settled" look for CONFIRMED, an attention look for PENDING/REFUND_DUE, a muted look for
 * CANCELLED). Defensive — an unknown/absent status reads as "Unknown" with the neutral tone, so a new
 * server-side state can never break the screen.
 * @param {string} status
 * @returns {{label: string, tone: "pending"|"confirmed"|"cancelled"|"refund"|"unknown"}}
 */
export function statusMeta(status) {
  switch (status) {
    case ORDER_STATUS.PENDING:
      return { label: "Awaiting payment", tone: "pending" };
    case ORDER_STATUS.CONFIRMED:
      return { label: "Confirmed", tone: "confirmed" };
    case ORDER_STATUS.CANCELLED:
      return { label: "Cancelled", tone: "cancelled" };
    case ORDER_STATUS.REFUND_DUE:
      return { label: "Refund due", tone: "refund" };
    case ORDER_STATUS.REFUNDED:
      // The money came back (TM-623) — reads as settled-and-closed, like a cancellation.
      return { label: "Refunded", tone: "cancelled" };
    case ORDER_STATUS.REFUND_ABANDONED:
      // TM-726: the automatic refund could not be issued and the money is still owed — reads as an
      // outstanding refund (attention tone), not settled, so it never looks closed to the customer.
      return { label: "Refund pending", tone: "refund" };
    case ORDER_STATUS.FAILED:
      // TM-634: the payment was declined/failed — terminal, no money taken. Reads as closed.
      return { label: "Payment failed", tone: "cancelled" };
    case ORDER_STATUS.EXPIRED:
      // TM-634: an abandoned checkout the TTL sweep retired — terminal, no money taken. Reads as closed.
      return { label: "Expired", tone: "cancelled" };
    default:
      return { label: "Unknown", tone: "unknown" };
  }
}

// --- Money ----------------------------------------------------------------------------------------

/**
 * Format an amount in pence as GBP: whole pounds without decimals (`£5`, `£0`), part-pounds to 2dp
 * (`£2.50`). Defensive — a non-finite / negative input renders as `£0` and never throws (mirrors the
 * sibling checkout core's formatPrice).
 * @param {number} pence
 * @returns {string}
 */
export function formatAmount(pence) {
  const p = Number(pence);
  if (!Number.isFinite(p) || p < 0) return "£0";
  const pounds = p / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

/**
 * The amount label shown on a purchase row: a £0 order reads as "Free" (a first-event / included /
 * £0 event), any other amount reads as the money value. Purely cosmetic on top of {@link formatAmount}.
 * @param {number} pence
 * @returns {string}
 */
export function amountLabel(pence) {
  const p = Number(pence);
  return Number.isFinite(p) && p > 0 ? formatAmount(p) : "Free";
}

// --- Dates ----------------------------------------------------------------------------------------

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC", // stable, timezone-independent output (deterministic in tests + across environments)
});

/**
 * Format an order's `createdAt` ISO-8601 instant as a short human date (`10 Jul 2026`), in UTC.
 * Defensive — an absent / unparseable value renders as an empty string rather than "Invalid Date".
 * @param {string} iso
 * @returns {string}
 */
export function formatOrderDate(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return DATE_FORMAT.format(new Date(ms));
}

// --- Order normalisation --------------------------------------------------------------------------

/**
 * Coerce one raw order from the endpoint to a safe shape. Ids fall back to null, the amount to a
 * non-negative integer (0), the status to whatever came back (rendered defensively by statusMeta), and
 * createdAt to null when absent. Never throws — the screen renders off whatever the endpoint returns.
 * @param {{id?: number, eventId?: number, amountPence?: number, status?: string, createdAt?: string}} raw
 */
export function normalizeOrder(raw) {
  const r = raw || {};
  const amount = Number(r.amountPence);
  return {
    id: r.id == null ? null : r.id,
    eventId: r.eventId == null ? null : r.eventId,
    amountPence: Number.isFinite(amount) && amount > 0 ? Math.trunc(amount) : 0,
    status: typeof r.status === "string" ? r.status : "",
    createdAt: r.createdAt == null ? null : String(r.createdAt),
  };
}

/**
 * Normalise + defensively sort a list of raw orders newest-first. The endpoint already sorts, but we
 * re-sort here so the screen is correct even off a stale cache or a re-ordered payload: by createdAt
 * descending, then id descending as a deterministic same-instant tiebreak (mirrors the backend's
 * `findByUserIdOrderByCreatedAtDescIdDesc`). A non-array input yields an empty list.
 * @param {Array} list
 * @returns {Array<{id: *, eventId: *, amountPence: number, status: string, createdAt: string|null}>}
 */
export function normalizeOrders(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(normalizeOrder)
    .sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      const na = Number.isNaN(ta) ? 0 : ta;
      const nb = Number.isNaN(tb) ? 0 : tb;
      if (nb !== na) return nb - na; // newest createdAt first
      return Number(b.id) - Number(a.id); // higher (later) id first as tiebreak
    });
}

/**
 * The label/value rows a receipt shows for one order — the "simple receipt view" (AC). Pure, so it is
 * unit-tested directly and the DOM half is a dumb painter over it.
 * @param {{id: *, eventId: *, amountPence: number, status: string, createdAt: string|null}} order
 * @returns {Array<{label: string, value: string}>}
 */
export function receiptLines(order) {
  const o = normalizeOrder(order);
  const lines = [
    { label: "Order", value: o.id == null ? "—" : `#${o.id}` },
    { label: "Event", value: o.eventId == null ? "—" : `#${o.eventId}` },
    { label: "Amount", value: amountLabel(o.amountPence) },
    { label: "Status", value: statusMeta(o.status).label },
  ];
  const date = formatOrderDate(o.createdAt);
  if (date) lines.push({ label: "Date", value: date });
  return lines;
}

// --- Runtime load (calls api.getMyOrders) ---------------------------------------------------------

/**
 * Fetch + normalise the caller's orders. Takes the api namespace injected (mock in tests, resolved from
 * `window.tmApi` at runtime), so it is unit-testable with no network: it calls `api.getMyOrders()` and
 * returns the normalised, newest-first list. A missing `getMyOrders` (older api bridge) yields an empty
 * list rather than throwing; a real network error propagates so the caller can show the error state.
 * @param {{getMyOrders?: () => Promise<Array>}} api
 * @returns {Promise<Array>}
 */
export async function loadOrders(api) {
  if (!api || typeof api.getMyOrders !== "function") return [];
  const raw = await api.getMyOrders();
  return normalizeOrders(raw);
}

// --- DOM half (painter) ---------------------------------------------------------------------------

/** One purchase row: the event, the amount + status badges, and the date. Clicking opens its receipt. */
function orderRow(order, onSelect) {
  const status = statusMeta(order.status);
  const date = formatOrderDate(order.createdAt);
  return el(
    "button",
    {
      type: "button",
      class: "tm-receipt-row tm-wobble",
      dataset: { orderId: order.id == null ? "" : String(order.id), status: order.status },
      onClick: () => onSelect(order),
    },
    [
      el("span", { class: "tm-receipt-row-main" }, [
        el("span", { class: "tm-receipt-row-event", text: order.eventId == null ? "Event" : `Event #${order.eventId}` }),
        date ? el("span", { class: "tm-receipt-row-date", text: date }) : null,
      ]),
      el("span", { class: "tm-receipt-row-meta" }, [
        el("span", { class: "tm-receipt-amount", text: amountLabel(order.amountPence) }),
        el("span", { class: `tm-receipt-status tm-receipt-status-${status.tone}`, text: status.label }),
      ]),
    ],
  );
}

/**
 * Paint the list of the caller's orders into `container` — or the empty state when there are none (AC:
 * "empty ... states"). `onSelect(order)` is called when a row is clicked (opens that order's receipt).
 * @param {HTMLElement} container
 * @param {Array} orders normalised orders (newest-first)
 * @param {{onSelect: (order: object) => void}} handlers
 */
export function renderList(container, orders, { onSelect } = {}) {
  if (!container) return;
  clear(container);
  container.appendChild(el("h2", { class: "tm-receipts-title", text: "My tickets & purchases" }));

  if (!orders || orders.length === 0) {
    container.appendChild(
      el("div", { class: "tm-receipts-empty tm-wobble" }, [
        el("p", { class: "tm-receipts-empty-title", text: "No purchases yet" }),
        el("p", {
          class: "tm-receipts-empty-body",
          text: "Events you register for and pay for will show up here.",
        }),
      ]),
    );
    return;
  }

  container.appendChild(
    el(
      "div",
      { class: "tm-receipts-list" },
      orders.map((order) => orderRow(order, (o) => (typeof onSelect === "function" ? onSelect(o) : undefined))),
    ),
  );
}

/**
 * Paint the simple receipt view for one order — the label/value lines from {@link receiptLines} plus a
 * Back action that returns to the list. `onBack()` is called when Back is clicked.
 * @param {HTMLElement} container
 * @param {object} order
 * @param {{onBack: () => void}} handlers
 */
export function renderReceipt(container, order, { onBack } = {}) {
  if (!container) return;
  clear(container);

  const back = el("button", {
    type: "button",
    class: "tm-btn tm-receipt-back",
    text: "Back to purchases",
    onClick: () => (typeof onBack === "function" ? onBack() : undefined),
  });

  const card = el("div", { class: "tm-receipt-card tm-wobble" }, [
    el("h2", { class: "tm-receipt-title", text: "Receipt" }),
    el(
      "dl",
      { class: "tm-receipt-lines" },
      receiptLines(order).flatMap((line) => [
        el("dt", { class: "tm-receipt-line-label", text: line.label }),
        el("dd", { class: "tm-receipt-line-value", text: line.value }),
      ]),
    ),
  ]);

  container.appendChild(back);
  container.appendChild(card);
}

/** The loading placeholder shown while the orders are being fetched (AC: "loading ... states"). */
export function renderLoading(container) {
  if (!container) return;
  clear(container);
  container.appendChild(el("h2", { class: "tm-receipts-title", text: "My tickets & purchases" }));
  container.appendChild(el("p", { class: "tm-receipts-loading", text: "Loading your purchases…" }));
}

/** The error state shown when the orders can't be loaded; `onRetry()` re-attempts the fetch. */
export function renderError(container, { onRetry } = {}) {
  if (!container) return;
  clear(container);
  container.appendChild(el("h2", { class: "tm-receipts-title", text: "My tickets & purchases" }));
  container.appendChild(
    el("div", { class: "tm-receipts-error tm-wobble" }, [
      el("p", { class: "tm-receipts-error-body", text: "We couldn't load your purchases just now." }),
      el("button", {
        type: "button",
        class: "tm-btn tm-receipts-retry",
        text: "Try again",
        onClick: () => (typeof onRetry === "function" ? onRetry() : undefined),
      }),
    ]),
  );
}

// --- Runtime mount (flag-gated; driven by router.js, inert while the flag is OFF) -----------------

const SCREEN_ID = "membership-receipts-screen";

/** The web runtime config (`window.TEAMMARHABA_CONFIG`), or an empty object off-DOM. */
function config() {
  return (typeof window !== "undefined" && window.TEAMMARHABA_CONFIG) || {};
}

/** True iff the membership feature flag is ON. READ only — TM-480 owns the flag and ships it OFF. */
export function membershipEnabled() {
  const cfg = config();
  return !!(cfg.flags && cfg.flags.membership);
}

/** The api namespace, resolved at runtime from api.js's `window.tmApi` bridge (see file header). */
function getApi() {
  return (typeof window !== "undefined" && window.tmApi) || {};
}

/**
 * Enter the receipts screen (TM-624): fetch + render the caller's orders into the screen section.
 * Called by router.js on entry into #/receipts — the app router now owns the screen's show/hide, its
 * auth guard, the mount-once lifecycle AND the nav reveal, exactly like the sibling membership-tier
 * screen (the TM-606 pattern). This module NO LONGER runs its own hashchange listener or reveals its
 * own nav link (both were the TM-481 self-managed lifecycle that double-rendered against router.js and
 * ignored the auth/gating states — the bug this ticket fixes). Clicking a purchase swaps the section to
 * that order's receipt in place; Back returns to the list (held in memory, no re-fetch). Only ever
 * entered while the flag is ON (router.js gates the whole route behind it).
 */
export async function enterMembershipReceipts() {
  if (typeof document === "undefined") return;
  const section = document.getElementById(SCREEN_ID);
  if (!section) return;

  const showList = (orders) =>
    renderList(section, orders, {
      onSelect: (order) => renderReceipt(section, order, { onBack: () => showList(orders) }),
    });

  renderLoading(section);
  try {
    const orders = await loadOrders(getApi());
    showList(orders);
  } catch (err) {
    console.warn("[membership-receipts] GET /me/orders failed:", err?.message ?? err);
    renderError(section, { onRetry: () => enterMembershipReceipts() });
  }
}
