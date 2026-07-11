// Revolut SDK loader memoisation/retry guard (TM-629). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG (review finding, frontend-ci LOW): loadRevolutSdk() in membership-checkout.js memoised its
// load promise but only `script.onerror` cleared the memo. Its two OTHER rejection paths left the
// REJECTED promise cached:
//   (1) a missing `revolutScriptUrl` (or no document) — the rejecting promise was assigned to the
//       memo variable AFTER the executor had already rejected, so the guard's early `return` didn't
//       prevent the caching;
//   (2) the script loaded but `window.RevolutCheckout` wasn't a function.
// After either, EVERY later payment attempt — on both screens that share the loader: the per-event
// checkout AND the TM-620 subscribe screen — instantly re-rejected with the stale error until a full
// page reload. "Try again" could never succeed.
//
// THE FIX: the loader logic moved into the pure factory createRevolutSdkLoader() in
// membership-checkout-core.js (membership-checkout.js itself imports api.js → the Firebase CDN, so it
// can never be loaded under `node --test` — the established core/view split). The contract under test:
// an in-flight load is shared, a resolved global short-circuits, and NO rejection is ever memoised.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createRevolutSdkLoader } from "../src/assets/membership-checkout-core.js";

/**
 * A minimal fake document: createElement returns a plain script-shaped object and head.appendChild
 * collects it, so a test can fire `onload`/`onerror` by hand and count how many <script>s were
 * actually injected.
 */
function fakeDocument() {
  const scripts = [];
  return {
    scripts,
    createElement: (tag) => ({ tag, src: "", async: false, onload: null, onerror: null }),
    head: {
      appendChild: (node) => {
        scripts.push(node);
      },
    },
  };
}

test("REGRESSION TM-629: a missing script URL rejects but is NOT memoised — configuring it later lets the retry succeed", async () => {
  const doc = fakeDocument();
  const globalObj = {};
  let url; // not configured yet (the deploy hasn't injected payments config)
  const load = createRevolutSdkLoader({
    getGlobal: () => globalObj,
    getDocument: () => doc,
    getScriptUrl: () => url,
  });

  // First attempt: no URL → an honest rejection…
  await assert.rejects(load(), /not configured/i);
  assert.equal(doc.scripts.length, 0, "nothing to inject without a URL");

  // …and the config arrives (or the user retries after an ops fix). Before the fix this second call
  // replayed the memoised "not configured" rejection forever; it must now inject the script and load.
  url = "https://sandbox-merchant.example/embed.js";
  const attempt = load();
  assert.equal(doc.scripts.length, 1, "the retry actually injects the SDK <script>");
  assert.equal(doc.scripts[0].src, url);
  globalObj.RevolutCheckout = function RevolutCheckout() {};
  doc.scripts[0].onload();
  assert.equal(await attempt, globalObj.RevolutCheckout, "the retry resolves with the SDK entry point");
});

test("REGRESSION TM-629: 'loaded but RevolutCheckout unavailable' rejects but is NOT memoised — the next attempt retries", async () => {
  const doc = fakeDocument();
  const globalObj = {};
  const load = createRevolutSdkLoader({
    getGlobal: () => globalObj,
    getDocument: () => doc,
    getScriptUrl: () => "https://sandbox-merchant.example/embed.js",
  });

  // First attempt: the script "loads" but never exposes the global (a broken/blocked CDN response).
  const first = load();
  assert.equal(doc.scripts.length, 1);
  doc.scripts[0].onload();
  await assert.rejects(first, /RevolutCheckout is unavailable/i);

  // Second attempt: before the fix this replayed the stale rejection without touching the network.
  // It must inject a FRESH script and succeed once the SDK actually arrives.
  const second = load();
  assert.equal(doc.scripts.length, 2, "the retry injects a fresh <script> instead of replaying the rejection");
  globalObj.RevolutCheckout = function RevolutCheckout() {};
  doc.scripts[1].onload();
  assert.equal(await second, globalObj.RevolutCheckout);
});

test("a transient script load error (onerror) stays retryable — the behaviour the old code already had", async () => {
  const doc = fakeDocument();
  const globalObj = {};
  const load = createRevolutSdkLoader({
    getGlobal: () => globalObj,
    getDocument: () => doc,
    getScriptUrl: () => "https://sandbox-merchant.example/embed.js",
  });

  const first = load();
  doc.scripts[0].onerror();
  await assert.rejects(first, /could not load/i);

  const second = load();
  assert.equal(doc.scripts.length, 2, "a CDN blip is retried with a fresh <script>");
  globalObj.RevolutCheckout = function RevolutCheckout() {};
  doc.scripts[1].onload();
  assert.equal(await second, globalObj.RevolutCheckout);
});

test("an in-flight load is shared: concurrent pay attempts inject exactly one <script>", async () => {
  const doc = fakeDocument();
  const globalObj = {};
  const load = createRevolutSdkLoader({
    getGlobal: () => globalObj,
    getDocument: () => doc,
    getScriptUrl: () => "https://sandbox-merchant.example/embed.js",
  });

  const a = load();
  const b = load(); // the user clicks Pay twice while the CDN is slow
  assert.equal(doc.scripts.length, 1, "the second call shares the in-flight load");
  globalObj.RevolutCheckout = function RevolutCheckout() {};
  doc.scripts[0].onload();
  assert.equal(await a, globalObj.RevolutCheckout);
  assert.equal(await b, globalObj.RevolutCheckout);
});

test("a resolved global short-circuits: no further script is ever injected once the SDK is present", async () => {
  const doc = fakeDocument();
  const globalObj = { RevolutCheckout: function RevolutCheckout() {} };
  const load = createRevolutSdkLoader({
    getGlobal: () => globalObj,
    getDocument: () => doc,
    getScriptUrl: () => "https://sandbox-merchant.example/embed.js",
  });
  assert.equal(await load(), globalObj.RevolutCheckout);
  assert.equal(await load(), globalObj.RevolutCheckout);
  assert.equal(doc.scripts.length, 0, "the SDK was already there — nothing to inject");
});
