// window.tmApi bridge completeness guard (TM-629). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG (review finding, frontend-ci LOW): api.js exported `checkout` (POST
// /api/v1/events/{id}/checkout, TM-477 — the helper that STARTS a per-event paid checkout) but never
// listed it on the `window.tmApi` bridge at the bottom of the file. The bridge is not a courtesy:
// contract TM-457 has whole modules (membership-tier.js, membership-receipts.js) resolve api at
// RUNTIME off `window.tmApi` precisely because they cannot statically import api.js (its Firebase CDN
// import chain is unloadable under Node and a named import of a not-yet-merged helper is a hard ESM
// link error). For those callers a missing bridge entry is silently `undefined` at the moment the
// user clicks — no CI signal, no console error at load.
//
// THE GUARD: api.js itself can't be imported here (same CDN chain), so this reads the SOURCE, parses
// every `export function` / `export async function` name, and asserts each one appears in the
// `window.tmApi = { … }` object literal. That makes the invariant structural: ADDING an export
// without bridging it fails CI, so the epic's "api.js already publishes every helper on window.tmApi"
// contract line can't silently rot again.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/api.js"), "utf8");

/** Every function api.js exports (declaration form — the only style the module uses). */
function exportedFunctionNames() {
  const names = [...SRC.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  assert.ok(names.length > 20, `sanity: expected a rich api surface, parsed only ${names.length} exports`);
  return names;
}

/** The bare identifiers listed in the `window.tmApi = { … }` shorthand object literal. */
function bridgedNames() {
  const block = SRC.match(/window\.tmApi\s*=\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(block, "could not locate the `window.tmApi = { … }` bridge object in api.js");
  return [...block[1].matchAll(/^\s*([A-Za-z0-9_$]+),\s*$/gm)].map((m) => m[1]);
}

test("REGRESSION TM-629: `checkout` — the per-event paid checkout starter — is on the window.tmApi bridge", () => {
  // The one helper the finding named: exported since TM-477, used by the pay flow, absent from the
  // bridge — so any bridge-pattern caller (the node-safe module style the epic mandates) could never
  // start a paid checkout.
  assert.ok(
    bridgedNames().includes("checkout"),
    "api.js exports `checkout` but does not publish it on window.tmApi — bridge-pattern callers get undefined",
  );
});

test("every exported api.js helper is published on the window.tmApi bridge (no drift)", () => {
  const bridged = new Set(bridgedNames());
  const missing = exportedFunctionNames().filter((name) => !bridged.has(name));
  assert.deepEqual(
    missing,
    [],
    `exported but NOT bridged: ${missing.join(", ")} — runtime-bridge callers (contract TM-457) silently get undefined`,
  );
});

test("the membership-epic helpers the tier/receipts screens resolve at runtime are all bridged", () => {
  // The concrete set the epic's screens read off window.tmApi (membership-tier.js header, TM-481
  // receipts). Belt-and-braces alongside the structural check above: these are the ones a regression
  // breaks user-visibly.
  const bridged = new Set(bridgedNames());
  for (const name of [
    "getMembership",
    "switchTier",
    "getSubscription",
    "subscriptionCheckout",
    "cancelSubscription",
    "adminGetUserSubscription",
    "getMyOrders",
    "getEventEntitlement",
    "checkout",
  ]) {
    assert.ok(bridged.has(name), `membership helper ${name} must be on window.tmApi`);
  }
});
