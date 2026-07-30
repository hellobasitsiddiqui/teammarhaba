// Unit tests for the offered-city resolver (TM-1165) — city-catalogue.js.
//
// city-catalogue.js imports getCityCatalogue from the api.js client (Firebase/auth-heavy, no Node
// harness) and cityOptionsFrom from profile-core.js. To exercise its fetch/cache/fallback wiring under
// Node without that import chain, we eval the module source with its two imports replaced by injected
// fakes (the same data-URL technique the profile-edit-behaviour harness uses): a controllable
// getCityCatalogue and the REAL cityOptionsFrom (imported here so the mapping is proven end-to-end).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cityOptionsFrom, CITY_FALLBACK } from "../src/assets/profile-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "assets", "city-catalogue.js");

/**
 * Load a FRESH copy of city-catalogue.js (its module cache reset per load) with its imports replaced
 * by injected deps: `getCityCatalogue` = the supplied fake, `cityOptionsFrom`/`CITY_FALLBACK` = the
 * real ones. Returns the module's exports.
 */
async function loadModule(getCityCatalogueFake) {
  const source = readFileSync(SRC, "utf8");
  // Strip the two top-level imports and inject the deps from a global the preamble destructures.
  const withoutImports = source.replace(/^import[\s\S]*?;$/gm, "");
  const preamble =
    "const { getCityCatalogue, cityOptionsFrom, CITY_FALLBACK } = globalThis.__CITY_DEPS__;\n";
  globalThis.__CITY_DEPS__ = {
    getCityCatalogue: getCityCatalogueFake,
    cityOptionsFrom,
    CITY_FALLBACK,
  };
  // A unique nonce per load so the Node ESM loader doesn't dedupe identical data-URLs into ONE cached
  // module instance (which would share the module-private resolvedNames/inflight state across tests).
  const nonce = `\n// nonce ${Math.random()}-${Date.now()}\n`;
  const code = preamble + withoutImports + nonce;
  assert.doesNotMatch(code, /^import[\s\S]*?from/m, "all imports must be replaced");
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

test("offeredCityNames serves the fallback until the catalogue resolves, then the catalogue (TM-1165)", async () => {
  const rows = [
    { name: "London", country: "United Kingdom" },
    { name: "Marhabaville", country: "Testland" },
  ];
  const mod = await loadModule(() => Promise.resolve(rows));

  // Before loadCityCatalogue resolves, the sync reader serves the hard fallback (never breaks offline).
  assert.deepEqual(mod.offeredCityNames(), [...CITY_FALLBACK]);

  const resolved = await mod.loadCityCatalogue();
  assert.deepEqual(resolved, ["London", "Marhabaville"]);
  // After resolution the sync reader returns the admin-managed catalogue names.
  assert.deepEqual(mod.offeredCityNames(), ["London", "Marhabaville"]);
});

test("loadCityCatalogue fetches at most once (cached) even with several callers (TM-1165)", async () => {
  let calls = 0;
  const mod = await loadModule(() => {
    calls += 1;
    return Promise.resolve([{ name: "London" }]);
  });
  await Promise.all([mod.loadCityCatalogue(), mod.loadCityCatalogue(), mod.loadCityCatalogue()]);
  assert.equal(calls, 1, "the network call happens once per page load, shared by all consumers");
});

test("a failed catalogue fetch resolves to the fallback and never rejects (TM-1165)", async () => {
  const mod = await loadModule(() => Promise.reject(new Error("network down")));
  // loadCityCatalogue must not reject — a caller can always await it and repaint.
  const resolved = await mod.loadCityCatalogue();
  assert.deepEqual(resolved, [...CITY_FALLBACK], "offline → the four fallback cities");
  // And the sync reader keeps serving the fallback (resolvedNames stayed null on failure).
  assert.deepEqual(mod.offeredCityNames(), [...CITY_FALLBACK]);
});

test("an empty catalogue payload falls back to the four cities so the picker never breaks (TM-1165)", async () => {
  const mod = await loadModule(() => Promise.resolve([]));
  const resolved = await mod.loadCityCatalogue();
  assert.deepEqual(resolved, [...CITY_FALLBACK]);
  assert.deepEqual(mod.offeredCityNames(), [...CITY_FALLBACK]);
});
