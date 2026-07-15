// Receipts-screen shell guards (TM-738 P1, TM-760). Framework-free — Node's built-in test runner, picked
// up by the CI glob `node --test web/tools/*.test.mjs`.
//
// membership-receipts.js's PURE decision functions (statusMeta / formatAmount / amountLabel /
// normalizeOrders / receiptLines / loadOrders) are exhaustively behaviourally unit-tested against a mock
// api in membership-receipts.test.mjs. What those tests do NOT cover is the DOM half — the painters
// (renderList / renderReceipt / renderError) and enterMembershipReceipts(), which build real DOM via
// ui.js's `el()` (document.createElement at call time). There is no jsdom in this Node-only harness (CI
// runs `node --test` with built-ins only), so — exactly like the sibling membership-checkout-screen.test
// and membership-subscribe-screen.test — the shell wiring is pinned with SOURCE-LEVEL guards over the
// module text. These are characterization tests for EXISTING behaviour (they pass as-is, no source change):
//
//   • receiptsScreenRenderOrderRowsAndDetail — the list painter renders one row per order (event / amount /
//     status, newest-first from the loaded list) and clicking a row swaps the section to that order's
//     receipt (renderReceipt over the pure receiptLines) with a Back action that returns to the list.
//   • receiptsErrorStateRendersRetry — a failed GET /me/orders is caught (never white-screens) and paints
//     the error state with a "Try again" button that re-runs the fetch.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/membership-receipts.js"), "utf8");

// --- the list renders order rows, a click opens the receipt detail -------------------------------

test("the screen entry loads the caller's orders and paints the list of rows (receiptsScreenRenderOrderRowsAndDetail)", () => {
  // enterMembershipReceipts fetches via the node-tested loadOrders and hands the result to renderList.
  assert.match(SRC, /async\s+function\s+enterMembershipReceipts\b/, "the router entry point exists");
  assert.match(
    SRC,
    /const\s+orders\s*=\s*await\s+loadOrders\(getApi\(\)\)/,
    "the entry fetches the caller's orders via the node-tested loadOrders(getApi())",
  );
  assert.match(SRC, /renderList\(section,\s*orders/, "…and paints them with renderList(section, orders, …)");

  // renderList paints one clickable row per order, carrying the event, amount + status the pure functions decide.
  const listFn = SRC.slice(SRC.indexOf("function renderList"));
  assert.match(listFn, /orders\.map\(\(order\)\s*=>\s*orderRow\(/, "renderList maps each order to an orderRow");
  const rowFn = SRC.slice(SRC.indexOf("function orderRow"), SRC.indexOf("function renderList"));
  assert.match(rowFn, /statusMeta\(order\.status\)/, "a row shows the pure statusMeta label/tone for the order");
  assert.match(rowFn, /amountLabel\(order\.amountPence\)/, "a row shows the pure amountLabel for the order");
  assert.match(rowFn, /onClick:\s*\(\)\s*=>\s*onSelect\(order\)/, "clicking a row selects that order (opens its receipt)");
});

test("selecting an order swaps the section to its receipt detail, with Back returning to the list (receiptsScreenRenderOrderRowsAndDetail)", () => {
  // The onSelect handler renders the receipt detail for the clicked order over the SAME section…
  assert.match(
    SRC,
    /onSelect:\s*\(order\)\s*=>\s*renderReceipt\(section,\s*order,\s*\{\s*onBack:/,
    "onSelect renders the clicked order's receipt into the section, with an onBack handler",
  );
  // …and renderReceipt paints the label/value lines the pure receiptLines() decides, plus a Back action.
  const receiptFn = SRC.slice(SRC.indexOf("function renderReceipt"));
  assert.match(receiptFn, /receiptLines\(order\)/, "the detail paints the pure receiptLines(order) label/value rows");
  assert.match(receiptFn, /text:\s*"Back to purchases"/, "the detail renders a Back-to-purchases action");
  assert.match(receiptFn, /onClick:\s*\(\)\s*=>\s*\(typeof\s+onBack\s*===\s*"function"/, "Back invokes onBack (returns to the list)");
});

// --- a failed load is caught and offers a retry --------------------------------------------------

test("a failed GET /me/orders is caught (never white-screens) and paints the error state with a retry (receiptsErrorStateRendersRetry)", () => {
  // The entry wraps the fetch in try/catch — a load failure must NOT throw out of the screen.
  assert.match(
    SRC,
    /try\s*\{[\s\S]{0,200}await\s+loadOrders\(getApi\(\)\)[\s\S]{0,200}\}\s*catch\s*\(err\)\s*\{/,
    "enterMembershipReceipts wraps the load in try/catch so a fetch error never white-screens the screen",
  );
  // The catch renders the error state, re-attaching the retry to a fresh screen entry.
  assert.match(
    SRC,
    /catch\s*\(err\)\s*\{[\s\S]{0,300}renderError\(section,\s*\{\s*onRetry:\s*\(\)\s*=>\s*enterMembershipReceipts\(\)/,
    "the catch paints renderError with onRetry re-running enterMembershipReceipts() (a fresh fetch)",
  );
});

test("renderError paints a 'Try again' button wired to onRetry (receiptsErrorStateRendersRetry)", () => {
  const errorFn = SRC.slice(SRC.indexOf("function renderError"));
  assert.match(errorFn, /class:\s*"tm-receipts-error/, "the error state renders the error card");
  assert.match(errorFn, /text:\s*"Try again"/, "…with a 'Try again' button");
  assert.match(
    errorFn,
    /onClick:\s*\(\)\s*=>\s*\(typeof\s+onRetry\s*===\s*"function"\s*\?\s*onRetry\(\)/,
    "the Try-again button invokes the onRetry handler",
  );
});
