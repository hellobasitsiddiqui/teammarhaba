// Tests for the geolocation helper (TM-280, epic TM-277). Framework-free — Node's built-in test
// runner, same harness as auth-env.test.mjs / fingerprint.test.mjs, picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// What's worth testing here (no real device, no browser): the runtime-selection + graceful-degrade
// contract. The helper must (a) pick the native Capacitor plugin only when actually on a native
// platform, (b) fall back to the browser API otherwise, (c) NEVER throw — permission denial and a
// missing API both resolve a tagged result. Every function takes an injectable `win`, so we feed it
// fake globals and assert the decision/outcome.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RATIONALE,
  getNativePlugin,
  isGeolocationSupported,
  getCurrentPosition,
} from "../src/assets/geolocation.js";

// --- Fake-runtime builders -------------------------------------------------

// A Capacitor global that reports native + exposes a Geolocation plugin built from `overrides`.
function nativeWin(plugin) {
  return {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: { Geolocation: plugin },
    },
  };
}

// The Capacitor WEB build: window.Capacitor exists but isNativePlatform() is false → must be
// treated as "no native plugin" so we fall through to navigator.geolocation.
function capacitorWebWin(navigatorGeo) {
  return {
    Capacitor: { isNativePlatform: () => false, Plugins: { Geolocation: {} } },
    navigator: navigatorGeo ? { geolocation: navigatorGeo } : undefined,
  };
}

// A plain browser: no Capacitor, optional navigator.geolocation.
function browserWin(navigatorGeo) {
  return { navigator: navigatorGeo ? { geolocation: navigatorGeo } : undefined };
}

const okPosition = { coords: { latitude: 51.5, longitude: -0.12, accuracy: 25 }, timestamp: 1 };

// --- RATIONALE -------------------------------------------------------------

test("a user-facing permission rationale is exported and non-empty", () => {
  assert.equal(typeof RATIONALE, "string");
  assert.ok(RATIONALE.length > 0);
  assert.match(RATIONALE, /location/i);
});

// --- getNativePlugin -------------------------------------------------------

test("native plugin is detected only on a real native platform", () => {
  const plugin = { getCurrentPosition: async () => okPosition };
  assert.equal(getNativePlugin(nativeWin(plugin)), plugin);
});

test("Capacitor web build is NOT treated as native", () => {
  assert.equal(getNativePlugin(capacitorWebWin()), null);
});

test("plain browser has no native plugin", () => {
  assert.equal(getNativePlugin(browserWin({})), null);
  assert.equal(getNativePlugin({}), null);
});

// --- isGeolocationSupported ------------------------------------------------

test("support is true with a native plugin, true with browser API, false with neither", () => {
  assert.equal(isGeolocationSupported(nativeWin({ getCurrentPosition: async () => okPosition })), true);
  assert.equal(isGeolocationSupported(browserWin({ getCurrentPosition() {} })), true);
  assert.equal(isGeolocationSupported(browserWin()), false);
  assert.equal(isGeolocationSupported({}), false);
});

// --- getCurrentPosition: native path ---------------------------------------

test("native: returns ok with normalised coords when permission granted", async () => {
  const plugin = {
    checkPermissions: async () => ({ location: "granted" }),
    getCurrentPosition: async () => okPosition,
  };
  const res = await getCurrentPosition({}, nativeWin(plugin));
  assert.equal(res.status, "ok");
  assert.deepEqual(res.coords, { latitude: 51.5, longitude: -0.12, accuracy: 25 });
});

test("native: prompts then resolves ok when user grants on request", async () => {
  const plugin = {
    checkPermissions: async () => ({ location: "prompt" }),
    requestPermissions: async () => ({ location: "granted" }),
    getCurrentPosition: async () => okPosition,
  };
  const res = await getCurrentPosition({}, nativeWin(plugin));
  assert.equal(res.status, "ok");
});

test("native: permission denial degrades to status 'denied', never throws", async () => {
  const plugin = {
    checkPermissions: async () => ({ location: "prompt" }),
    requestPermissions: async () => ({ location: "denied" }),
    getCurrentPosition: async () => {
      throw new Error("should not be called");
    },
  };
  const res = await getCurrentPosition({}, nativeWin(plugin));
  assert.equal(res.status, "denied");
});

test("native: a thrown permission error is classified, not propagated", async () => {
  const plugin = {
    checkPermissions: async () => ({ location: "granted" }),
    getCurrentPosition: async () => {
      const e = new Error("User denied Geolocation");
      throw e;
    },
  };
  const res = await getCurrentPosition({}, nativeWin(plugin));
  assert.equal(res.status, "denied");
});

// --- getCurrentPosition: web path ------------------------------------------

test("web: success callback maps to ok result", async () => {
  const geo = {
    getCurrentPosition(success) {
      success(okPosition);
    },
  };
  const res = await getCurrentPosition({}, capacitorWebWin(geo));
  assert.equal(res.status, "ok");
  assert.equal(res.coords.latitude, 51.5);
});

test("web: PERMISSION_DENIED (code 1) maps to 'denied'", async () => {
  const geo = {
    getCurrentPosition(_success, error) {
      error({ code: 1, message: "User denied Geolocation" });
    },
  };
  const res = await getCurrentPosition({}, browserWin(geo));
  assert.equal(res.status, "denied");
});

test("web: TIMEOUT (code 3) maps to 'timeout'", async () => {
  const geo = {
    getCurrentPosition(_success, error) {
      error({ code: 3, message: "Timeout expired" });
    },
  };
  const res = await getCurrentPosition({}, browserWin(geo));
  assert.equal(res.status, "timeout");
});

// --- getCurrentPosition: no API --------------------------------------------

test("no geolocation API anywhere degrades to 'unavailable' without throwing", async () => {
  const res = await getCurrentPosition({}, browserWin());
  assert.equal(res.status, "unavailable");
  const res2 = await getCurrentPosition({}, {});
  assert.equal(res2.status, "unavailable");
});

// --- P2 edge coverage (TM-762): message-string classification + coarse-only grant ----------
//
// Both branches below exercise EXISTING behaviour the sibling tests above leave uncovered — the
// Capacitor error shape (a thrown Error with a message string but NO numeric W3C `.code`) and the
// Android coarse-only permission grant. They characterize what the helper already does; no source
// change is expected (they pass green as-is).

// The W3C-code path is well-covered (code 1/3), and the native path proves a *denied*-message throw
// maps to "denied". But classifyError also has a message-STRING timeout branch and a catch-all
// "unavailable" fallback for an unrecognised message — the Capacitor plugin rejects with a bare
// Error (no numeric code), so these are the branches that actually fire on native. Assert both,
// and confirm the thrown message is surfaced (never swallowed) in the tagged result.
test("native: a thrown timeout MESSAGE (no numeric code) classifies as 'timeout'", async () => {
  const plugin = {
    checkPermissions: async () => ({ location: "granted" }),
    getCurrentPosition: async () => {
      throw new Error("Location request timed out");
    },
  };
  const res = await getCurrentPosition({}, nativeWin(plugin));
  assert.equal(res.status, "timeout");
  assert.match(res.error, /timed out/i, "the original failure message is carried through, not swallowed");
});

test("native: an unrecognised failure MESSAGE (no numeric code) falls back to 'unavailable'", async () => {
  const plugin = {
    checkPermissions: async () => ({ location: "granted" }),
    getCurrentPosition: async () => {
      throw new Error("Position unavailable");
    },
  };
  const res = await getCurrentPosition({}, nativeWin(plugin));
  // Not "denied"/"permission" and not "timed out"/"timeout" → the safe catch-all.
  assert.equal(res.status, "unavailable");
});

// Android can grant COARSE location only (fine denied). ensureNativePermission reads
// `status.location || status.coarseLocation`, so a status that reports coarseLocation="granted"
// with no `location` field must still be treated as granted and proceed to a fix. The sibling
// native tests only ever supply `location`, so the coarse-only fallback is otherwise untested.
test("native: a COARSE-only permission grant (no fine `location`) still proceeds to a fix", async () => {
  const plugin = {
    checkPermissions: async () => ({ coarseLocation: "granted" }), // no `location` key at all
    getCurrentPosition: async () => okPosition,
  };
  const res = await getCurrentPosition({}, nativeWin(plugin));
  assert.equal(res.status, "ok");
  assert.deepEqual(res.coords, { latitude: 51.5, longitude: -0.12, accuracy: 25 });
});
