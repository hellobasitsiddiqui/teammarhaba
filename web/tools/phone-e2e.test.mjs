// Tests for the phone-auth e2e gate (TM-302 / TM-309 / TM-318). Framework-free — Node's built-in
// test runner, same harness as auth-env.test.mjs and picked up by the CI glob
// `node --test web/tools/*.test.mjs`.
//
// Guards the core safety contract that CANNOT be reproduced in an emulator and MUST NOT regress: the
// reCAPTCHA app-verification bypass is enabled ONLY when the bypass is BOTH explicitly requested AND
// the context is provably not the public site. In particular it guards TM-318: that the persisted
// localStorage key is honoured as a request signal inside a safe context, but is a no-op on the
// public site (no emulator, no native shell).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  persistedPhoneE2eFlag,
  phoneE2eRequested,
  phoneE2eContextSafe,
  shouldDisablePhoneAppVerification,
  E2E_PHONE_LOCALSTORAGE_KEY,
} from "../src/assets/phone-e2e.js";

// A minimal fake localStorage backed by a plain object.
function fakeLocalStorage(store = {}) {
  return { getItem: (k) => (k in store ? store[k] : null) };
}

// A fake `window` with whatever signals a test needs.
function win({ config, global, ls, native } = {}) {
  const w = {};
  if (config !== undefined) w.TEAMMARHABA_CONFIG = config;
  if (global !== undefined) w.__TM_E2E_PHONE_TEST__ = global;
  if (ls !== undefined) w.localStorage = ls;
  if (native !== undefined) w.Capacitor = { isNativePlatform: () => native };
  return w;
}

// ── persistedPhoneE2eFlag ──────────────────────────────────────────────────────────────────────

test("persisted flag is true only when localStorage holds exactly '1'", () => {
  assert.equal(persistedPhoneE2eFlag(win({ ls: fakeLocalStorage({ [E2E_PHONE_LOCALSTORAGE_KEY]: "1" }) })), true);
  assert.equal(persistedPhoneE2eFlag(win({ ls: fakeLocalStorage({ [E2E_PHONE_LOCALSTORAGE_KEY]: "0" }) })), false);
  assert.equal(persistedPhoneE2eFlag(win({ ls: fakeLocalStorage({ [E2E_PHONE_LOCALSTORAGE_KEY]: "true" }) })), false);
  assert.equal(persistedPhoneE2eFlag(win({ ls: fakeLocalStorage({}) })), false);
});

test("persisted flag fails closed when localStorage is absent or throws", () => {
  assert.equal(persistedPhoneE2eFlag(win({})), false); // no localStorage at all
  const throwingLs = {
    getItem() {
      throw new Error("SecurityError: localStorage is not available");
    },
  };
  assert.equal(persistedPhoneE2eFlag(win({ ls: throwingLs })), false);
});

// ── phoneE2eRequested ──────────────────────────────────────────────────────────────────────────

test("requested is true for any of the three signals", () => {
  assert.equal(phoneE2eRequested(win({ config: { phoneTestMode: true } })), true);
  assert.equal(phoneE2eRequested(win({ global: true })), true);
  assert.equal(phoneE2eRequested(win({ ls: fakeLocalStorage({ [E2E_PHONE_LOCALSTORAGE_KEY]: "1" }) })), true);
});

test("requested is false with no signal, or with only falsy/look-alike values", () => {
  assert.equal(phoneE2eRequested(win({})), false);
  assert.equal(phoneE2eRequested(win({ config: { phoneTestMode: false } })), false);
  // A truthy-but-not-=== value must NOT count (strict checks).
  assert.equal(phoneE2eRequested(win({ config: { phoneTestMode: "true" } })), false);
  assert.equal(phoneE2eRequested(win({ global: "true" })), false);
});

// ── phoneE2eContextSafe ────────────────────────────────────────────────────────────────────────

test("context is safe with the emulator wired in OR the native Capacitor shell", () => {
  assert.equal(phoneE2eContextSafe(win({ config: { authEmulatorHost: "127.0.0.1:9099" } })), true);
  assert.equal(phoneE2eContextSafe(win({ native: true })), true);
});

test("context is NOT safe on the public site (no emulator, no native shell)", () => {
  assert.equal(phoneE2eContextSafe(win({})), false);
  assert.equal(phoneE2eContextSafe(win({ config: {} })), false);
  assert.equal(phoneE2eContextSafe(win({ native: false })), false);
});

// ── shouldDisablePhoneAppVerification — the combined gate ─────────────────────────────────────────

test("bypass enabled only when BOTH requested AND context-safe", () => {
  // Persisted flag + native shell → enabled (the TM-318 mobile-e2e path).
  assert.equal(
    shouldDisablePhoneAppVerification(
      win({ ls: fakeLocalStorage({ [E2E_PHONE_LOCALSTORAGE_KEY]: "1" }), native: true }),
    ),
    true,
  );
  // Window global + emulator → enabled (the browser-e2e path).
  assert.equal(
    shouldDisablePhoneAppVerification(win({ global: true, config: { authEmulatorHost: "127.0.0.1:9099" } })),
    true,
  );
});

test("PUBLIC-SITE SAFETY: a persisted/requested flag is a NO-OP without a safe context", () => {
  // The exact production risk: a stray localStorage value on the public site must never enable the
  // bypass, because the context-safe half of the gate fails (no emulator, no native shell).
  assert.equal(
    shouldDisablePhoneAppVerification(win({ ls: fakeLocalStorage({ [E2E_PHONE_LOCALSTORAGE_KEY]: "1" }) })),
    false,
  );
  assert.equal(shouldDisablePhoneAppVerification(win({ global: true })), false);
  assert.equal(shouldDisablePhoneAppVerification(win({ config: { phoneTestMode: true } })), false);
});

test("requested without a flag is a no-op even in a safe context", () => {
  // Native shell but nothing requested → bypass stays OFF (no accidental weakening in the app).
  assert.equal(shouldDisablePhoneAppVerification(win({ native: true })), false);
  assert.equal(
    shouldDisablePhoneAppVerification(win({ config: { authEmulatorHost: "127.0.0.1:9099" } })),
    false,
  );
});

test("malformed window inputs never throw and default to no-bypass", () => {
  assert.equal(phoneE2eRequested(null), false);
  assert.equal(phoneE2eContextSafe(null), false);
  assert.equal(shouldDisablePhoneAppVerification(undefined), false);
  assert.equal(persistedPhoneE2eFlag(null), false);
});
