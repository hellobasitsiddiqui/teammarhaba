// Tests for the boot-screen DOM driver (TM-381). Framework-free — Node's built-in test runner, picked
// up by the CI glob `node --test web/tools/*.test.mjs`. We drive showBootTagline / dismissBoot with an
// injected fake `window` (a tiny DOM + localStorage), so the localStorage no-immediate-repeat
// round-trip, the tagline write, and the idempotent dismiss are all covered without a real browser.
//
// Importing boot-screen.js runs its module-level initBootScreen() against the real globalThis, which in
// Node has no `document` — so it's a complete no-op (proving the import-safe/off-DOM contract), the same
// pattern as splash.test.mjs.

import assert from "node:assert/strict";
import { test } from "node:test";

import { showBootTagline, dismissBoot } from "../src/assets/boot-screen.js";
import { TAGLINES } from "../src/assets/boot-core.js";

/** A minimal fake element: enough of the DOM surface the driver touches. */
function fakeEl() {
  return {
    textContent: "",
    dataset: {},
    classList: { _set: new Set(), add(c) { this._set.add(c); }, contains(c) { return this._set.has(c); } },
    _listeners: {},
    addEventListener(type, cb) { this._listeners[type] = cb; },
    _removed: false,
    remove() { this._removed = true; },
  };
}

/** A fake `window` with a document exposing the given elements by id, plus a working localStorage. */
function makeWin(elements, { store = {} } = {}) {
  return {
    document: { getElementById: (id) => elements[id] || null },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    Math: { random: () => 0 }, // deterministic: first candidate
    setTimeout: () => 0,        // no real timers in the test
    _store: store,
  };
}

test("showBootTagline writes a tagline into the slot, marks it ready, and persists it", () => {
  const slot = fakeEl();
  const win = makeWin({ "boot-tagline": slot });

  const shown = showBootTagline(win);

  assert.ok(TAGLINES.includes(shown), "returns one of the configured taglines");
  assert.equal(slot.textContent, shown, "the slot shows the chosen tagline");
  assert.equal(slot.dataset.ready, "true", "the slot is marked ready so CSS can fade it in");
  assert.equal(win._store["tm.boot.lastTagline"], shown, "the choice is persisted for next launch");
});

test("showBootTagline avoids the previously-persisted tagline (no immediate repeat)", () => {
  const slot = fakeEl();
  // Seed localStorage with the item rng=0 would otherwise pick (index 0) so we can prove it's skipped.
  const previous = TAGLINES[0];
  const win = makeWin({ "boot-tagline": slot }, { store: { "tm.boot.lastTagline": previous } });

  const shown = showBootTagline(win);

  assert.notEqual(shown, previous, "the previous launch's tagline is not shown again");
  assert.equal(win._store["tm.boot.lastTagline"], shown, "the new choice replaces the stored one");
});

test("showBootTagline is a no-op when there's no #boot-tagline slot", () => {
  const win = makeWin({}); // no elements
  assert.equal(showBootTagline(win), null);
});

test("showBootTagline survives a broken localStorage (still shows a tagline)", () => {
  const slot = fakeEl();
  const win = {
    document: { getElementById: (id) => (id === "boot-tagline" ? slot : null) },
    localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } },
    Math: { random: () => 0 },
    setTimeout: () => 0,
  };
  const shown = showBootTagline(win);
  assert.ok(TAGLINES.includes(shown), "a blocked localStorage still yields a (possibly repeated) tagline");
  assert.equal(slot.textContent, shown);
});

test("dismissBoot fades out once, is idempotent, and schedules removal", () => {
  const screen = fakeEl();
  const win = makeWin({ "boot-screen": screen });

  const first = dismissBoot(win);
  const second = dismissBoot(win);

  assert.equal(first, true, "first call issues the dismiss");
  assert.equal(second, false, "second call is a no-op (already dismissed)");
  assert.ok(screen.classList.contains("is-hiding"), "the fade-out class is applied");
  assert.equal(screen.dataset.dismissed, "true");

  // Firing the transitionend listener removes the overlay from the DOM.
  screen._listeners.transitionend();
  assert.equal(screen._removed, true, "the overlay is removed after the fade");
});

test("dismissBoot is a no-op when there's no overlay", () => {
  assert.equal(dismissBoot(makeWin({})), false);
});
