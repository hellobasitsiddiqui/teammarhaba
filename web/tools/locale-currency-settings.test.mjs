// Language + currency preference PLACEHOLDER pickers (TM-1124).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// The load-bearing guarantee of this ticket is that the two pickers are VISUAL-ONLY: selecting one
// persists to localStorage but makes NO backend/API call and has no functional effect. These tests pin
// exactly that:
//   • the pure core (locale-currency-core.js) — the option catalogues, defaults, validation, and the
//     read/write localStorage round-trip (fallbacks on absent/invalid/locked storage), AND
//   • the settings UI (locale-currency-settings.js) driven for real against a tiny fake DOM: both
//     dropdowns render with the right options + the stored selection, a change persists to localStorage,
//     and — the fail-before/after — NO fetch/XHR is ever fired (a fetch spy throws if touched).
//
// locale-currency-settings.js imports ONLY ui.js's el() kit (no api.js / Firebase-CDN import chain), so
// it is directly evaluable under `node --test` — the whole point of keeping the placeholder api-free.

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LANGUAGE_OPTIONS,
  CURRENCY_OPTIONS,
  LANGUAGE_IDS,
  CURRENCY_IDS,
  DEFAULT_LANGUAGE_ID,
  DEFAULT_CURRENCY_ID,
  LANGUAGE_KEY,
  CURRENCY_KEY,
  isValidLanguageId,
  isValidCurrencyId,
  readLanguage,
  readCurrency,
  writeLanguage,
  writeCurrency,
} from "../src/assets/locale-currency-core.js";

// ── A minimal in-memory Storage double ─────────────────────────────────────────────────────────────
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

// A Storage that throws on every access — models private-mode / disabled storage.
const lockedStorage = {
  getItem() {
    throw new Error("locked");
  },
  setItem() {
    throw new Error("locked");
  },
};

// ── Pure core: catalogues + defaults ────────────────────────────────────────────────────────────────

test("the ticket's language + currency options are all offered", () => {
  // The ticket names these explicitly — assert each is present (by id) so the copy can't silently drop one.
  for (const id of ["en", "ar", "fr", "ur"]) assert.ok(LANGUAGE_IDS.includes(id), `language ${id} offered`);
  for (const id of ["GBP", "USD", "EUR", "SAR"]) assert.ok(CURRENCY_IDS.includes(id), `currency ${id} offered`);
  // Every option is a well-formed {id,label}.
  for (const o of [...LANGUAGE_OPTIONS, ...CURRENCY_OPTIONS]) {
    assert.equal(typeof o.id, "string");
    assert.ok(o.label && typeof o.label === "string", "every option has a human label");
  }
});

test("defaults are the first option — English / GBP (the app's real UI + billing today)", () => {
  assert.equal(DEFAULT_LANGUAGE_ID, "en");
  assert.equal(DEFAULT_CURRENCY_ID, "GBP");
  assert.equal(LANGUAGE_OPTIONS[0].id, DEFAULT_LANGUAGE_ID);
  assert.equal(CURRENCY_OPTIONS[0].id, DEFAULT_CURRENCY_ID);
});

test("validation only accepts an offered id", () => {
  assert.ok(isValidLanguageId("ar") && isValidCurrencyId("SAR"));
  assert.ok(!isValidLanguageId("de") && !isValidLanguageId("") && !isValidLanguageId(null));
  assert.ok(!isValidCurrencyId("JPY") && !isValidCurrencyId("gbp") /* case-sensitive */);
});

// ── Pure core: localStorage round-trip + resilience ────────────────────────────────────────────────

test("read falls back to the default when nothing is stored, and round-trips a written value", () => {
  const s = fakeStorage();
  assert.equal(readLanguage(s), DEFAULT_LANGUAGE_ID, "no stored language → default");
  assert.equal(readCurrency(s), DEFAULT_CURRENCY_ID, "no stored currency → default");

  assert.equal(writeLanguage(s, "ar"), true);
  assert.equal(writeCurrency(s, "USD"), true);
  assert.equal(s._dump()[LANGUAGE_KEY], "ar", "language persisted under its key");
  assert.equal(s._dump()[CURRENCY_KEY], "USD", "currency persisted under its key");
  assert.equal(readLanguage(s), "ar", "stored language survives a re-read (reload)");
  assert.equal(readCurrency(s), "USD", "stored currency survives a re-read (reload)");
});

test("an invalid or tampered stored value is ignored (falls back to default; never persisted)", () => {
  const s = fakeStorage();
  s.setItem(LANGUAGE_KEY, "klingon");
  s.setItem(CURRENCY_KEY, "'; DROP TABLE users;--");
  assert.equal(readLanguage(s), DEFAULT_LANGUAGE_ID, "junk language → default");
  assert.equal(readCurrency(s), DEFAULT_CURRENCY_ID, "junk currency → default");
  // writePref refuses to persist an unknown id.
  assert.equal(writeLanguage(s, "de"), false);
  assert.equal(writeCurrency(s, "JPY"), false);
});

test("a locked/absent Storage never throws — read returns the default, write returns false", () => {
  assert.equal(readLanguage(lockedStorage), DEFAULT_LANGUAGE_ID);
  assert.equal(readCurrency(lockedStorage), DEFAULT_CURRENCY_ID);
  assert.equal(writeLanguage(lockedStorage, "ar"), false);
  assert.equal(readLanguage(null), DEFAULT_LANGUAGE_ID, "a null storage is tolerated too");
});

// ── Settings UI driven against a fake DOM — render + persist + NO network ───────────────────────────
//
// A tiny Element/Document double: enough for el() (createElement + attributes + append + textContent +
// change events + a live .value on <select> that tracks the last-selected option).

function makeEl(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    attributes: {},
    className: "",
    dataset: {},
    listeners: {},
    _value: undefined,
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === "id") this.id = String(v);
    },
    getAttribute(k) {
      if (k === "class") return this.className || null;
      return k in this.attributes ? this.attributes[k] : null;
    },
    get children() {
      return this.childNodes.filter((c) => c.nodeType === 1);
    },
    append(...kids) {
      for (const kid of kids) {
        const child = kid && kid.nodeType ? kid : makeText(String(kid));
        child.parentNode = this;
        this.childNodes.push(child);
      }
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    dispatch(type, ev = {}) {
      (this.listeners[type] ?? []).forEach((fn) => fn(ev));
    },
    // <select>.value: default to the option carrying the `selected` attribute, else the first option.
    get value() {
      if (this._value !== undefined) return this._value;
      const opts = this.querySelectorAll("option");
      const sel = opts.find((o) => o.getAttribute("selected") != null) || opts[0];
      return sel ? sel.getAttribute("value") : "";
    },
    set value(v) {
      this._value = String(v);
    },
    querySelectorAll(sel) {
      const wantTag = String(sel).toUpperCase();
      const wantId = sel.startsWith("#") ? sel.slice(1) : null;
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (wantId ? c.id === wantId : c.tagName === wantTag) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    set textContent(v) {
      this.childNodes = [];
      if (v !== "") this.append(makeText(String(v)));
    },
    get textContent() {
      return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join("");
    },
    style: {},
  };
  return node;
}
function makeText(str) {
  return { nodeType: 3, data: String(str), parentNode: null };
}

let store;
let buildLocaleCurrencySettings;

// A fetch/XHR spy that FAILS the test the instant the placeholder touches the network — the core AC.
let networkTouched = null;
function trap(name) {
  return (...args) => {
    networkTouched = { name, args };
    throw new Error(`placeholder made a network call via ${name} — it must be inert (TM-1124)`);
  };
}

// Install globals ONCE before importing the module (ESM imports are cached; el() reads `document` at
// call time so a per-test document swap still works).
store = fakeStorage();
globalThis.document = {
  createElement: (tag) => makeEl(tag),
  createTextNode: (str) => makeText(str),
};
globalThis.window = { localStorage: store };
globalThis.fetch = trap("fetch");
globalThis.XMLHttpRequest = function () {
  trap("XMLHttpRequest")();
};
({ buildLocaleCurrencySettings } = await import("../src/assets/locale-currency-settings.js"));

beforeEach(() => {
  store = fakeStorage();
  globalThis.window = { localStorage: store };
  networkTouched = null;
});

test("renders a Preferences section with a Language and a Currency <select>, each carrying every option", () => {
  const section = buildLocaleCurrencySettings();
  assert.equal(section.tagName, "SECTION");
  assert.equal(section.getAttribute("aria-label"), "Preferences");

  const lang = section.querySelector("#pref-language");
  const cur = section.querySelector("#pref-currency");
  assert.ok(lang && lang.tagName === "SELECT", "language <select> rendered");
  assert.ok(cur && cur.tagName === "SELECT", "currency <select> rendered");

  const langValues = lang.querySelectorAll("option").map((o) => o.getAttribute("value"));
  const curValues = cur.querySelectorAll("option").map((o) => o.getAttribute("value"));
  assert.deepEqual(langValues, [...LANGUAGE_IDS], "every language option is present, in order");
  assert.deepEqual(curValues, [...CURRENCY_IDS], "every currency option is present, in order");

  // No network at render.
  assert.equal(networkTouched, null, "rendering the pickers makes no network call");
});

test("pre-selects the value already stored in localStorage (survives reload)", () => {
  store.setItem(LANGUAGE_KEY, "fr");
  store.setItem(CURRENCY_KEY, "EUR");
  const section = buildLocaleCurrencySettings();
  assert.equal(section.querySelector("#pref-language").value, "fr", "stored language is pre-selected");
  assert.equal(section.querySelector("#pref-currency").value, "EUR", "stored currency is pre-selected");
});

test("selecting a language persists to localStorage ONLY — no network call", () => {
  const section = buildLocaleCurrencySettings();
  const lang = section.querySelector("#pref-language");

  lang.value = "ar";
  lang.dispatch("change");

  assert.equal(store.getItem(LANGUAGE_KEY), "ar", "the pick is written to localStorage");
  assert.equal(networkTouched, null, "…and NOTHING was sent to the backend (fetch/XHR untouched)");
});

test("selecting a currency persists to localStorage ONLY — no network call", () => {
  const section = buildLocaleCurrencySettings();
  const cur = section.querySelector("#pref-currency");

  cur.value = "SAR";
  cur.dispatch("change");

  assert.equal(store.getItem(CURRENCY_KEY), "SAR", "the pick is written to localStorage");
  assert.equal(networkTouched, null, "…and NOTHING was sent to the backend (fetch/XHR untouched)");
});

test("the module imports no api.js (can't accidentally start calling the server)", () => {
  // A source-text guard so a future edit that pulls in api.js (and thus a real endpoint) trips this.
  // Read the shipped file rather than rely on the import graph alone.
  const src = fileURLToPath(new URL("../src/assets/locale-currency-settings.js", import.meta.url));
  const text = readFileSync(src, "utf8");
  assert.doesNotMatch(text, /from\s+["']\.\/api\.js["']/, "must not import api.js");
  assert.doesNotMatch(text, /\bfetch\s*\(/, "must not call fetch() directly");
});
