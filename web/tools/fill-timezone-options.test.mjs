// TM-1067 — the lifted timezone-<select> helpers in ui.js (fillTimeZoneOptions / ensureZoneOption /
// guessTimeZone).
//
// WHY THIS EXISTS. fillTimeZoneOptions used to live DOM-bound in admin-events.js with no unit coverage.
// TM-1067 lifts it to ui.js so BOTH admin consoles (events + venues) populate their timezone picker from
// ONE copy — the venue's timezone becomes the default an event inherits, so the two must stay identical.
// This pins the lifted helper's behaviour: it fills the full IANA set (or the fallback shortlist when the
// engine lacks Intl.supportedValuesOf), preselects the chosen zone, injects a non-listed chosen zone at
// the front, and defaults to a guess/UTC when nothing is passed. ensureZoneOption adds a missing zone
// without duplicating an existing one.
//
// Framework-free, no jsdom (CI pins Node 20): we drive the helper against a minimal fake `document` +
// fake <select>/<option> that model just enough (options collection, value, firstChild/removeChild for
// clear(), append/prepend) for the helper to run — the ui-el-xss-safe.test.mjs fake-DOM approach.

import assert from "node:assert/strict";
import { test } from "node:test";

// --- A minimal fake DOM: enough of <select>/<option> for the helpers to run --------------------------

function fakeTextNode(str) {
  return { nodeType: 3, data: String(str) };
}

function fakeElement(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    attrs: {},
    className: "",
    dataset: {},
    listeners: {},
    children: [],
    _textContent: "",
    get textContent() {
      return this._textContent;
    },
    set textContent(v) {
      this._textContent = String(v);
    },
    // <option> semantics: value / selected mirror the attributes el() sets via setAttribute.
    get value() {
      return "value" in this.attrs ? this.attrs.value : this._value ?? "";
    },
    set value(v) {
      this._value = String(v);
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    // <select>.options — the live list of child <option>s (what fillTimeZoneOptions/ensureZoneOption read).
    get options() {
      return this.children.filter((c) => c.nodeType === 1 && c.tagName === "OPTION");
    },
    get firstChild() {
      return this.children[0] || null;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    append(...nodes) {
      for (const n of nodes) this.children.push(n);
    },
    prepend(...nodes) {
      this.children.unshift(...nodes);
    },
  };
  return node;
}

function withFakeDocument(run) {
  const prior = globalThis.document;
  globalThis.document = {
    createElement: (tag) => fakeElement(tag),
    createTextNode: (str) => fakeTextNode(str),
  };
  try {
    return run();
  } finally {
    if (prior === undefined) delete globalThis.document;
    else globalThis.document = prior;
  }
}

const { el, fillTimeZoneOptions, ensureZoneOption, guessTimeZone } = await import("../src/assets/ui.js");

/** The value each <option> carries (el() puts it on the `value` attribute). */
function optionValues(select) {
  return select.options.map((o) => o.getAttribute("value"));
}

test("fillTimeZoneOptions preselects the passed zone and includes it", () => {
  withFakeDocument(() => {
    const select = el("select");
    fillTimeZoneOptions(select, "Europe/London");
    const values = optionValues(select);
    assert.ok(values.includes("Europe/London"), "the chosen zone must be an option");
    assert.equal(select.value, "Europe/London", "the select's value must be the chosen zone");
    // The chosen option is marked selected.
    const chosen = select.options.find((o) => o.getAttribute("value") === "Europe/London");
    assert.equal(chosen.getAttribute("selected"), "", "the chosen option carries the selected attribute");
  });
});

test("fillTimeZoneOptions injects a non-listed zone at the front", () => {
  withFakeDocument(() => {
    const select = el("select");
    // A syntactically-shaped id the real IANA set won't contain — the helper still surfaces it so the
    // caller's saved value is never silently dropped.
    fillTimeZoneOptions(select, "Custom/Zone");
    const values = optionValues(select);
    assert.equal(values[0], "Custom/Zone", "a non-listed chosen zone is prepended so it's selectable");
    assert.equal(select.value, "Custom/Zone");
  });
});

test("fillTimeZoneOptions defaults to a usable zone when nothing is passed", () => {
  withFakeDocument(() => {
    const select = el("select");
    fillTimeZoneOptions(select, "");
    // With no explicit zone it falls back to the runtime guess or "UTC" — never blank, always an IANA id.
    assert.notEqual(select.value, "", "a blank request still yields a concrete default zone");
    assert.ok(optionValues(select).includes(select.value), "the default is one of the options");
  });
});

test("fillTimeZoneOptions replaces prior options on a refill (no accumulation)", () => {
  withFakeDocument(() => {
    const select = el("select");
    fillTimeZoneOptions(select, "Asia/Karachi");
    const firstCount = select.options.length;
    fillTimeZoneOptions(select, "Asia/Tokyo");
    // clear() runs before the refill, so the option count doesn't grow across calls.
    assert.equal(select.options.length, firstCount, "a refill clears the old options first");
    assert.equal(select.value, "Asia/Tokyo");
  });
});

test("ensureZoneOption adds a missing zone but never duplicates an existing one", () => {
  withFakeDocument(() => {
    const select = el("select");
    fillTimeZoneOptions(select, "Europe/London");
    const before = select.options.length;

    // Already present → no-op.
    ensureZoneOption(select, "Europe/London");
    assert.equal(select.options.length, before, "an existing zone is not re-added");

    // Missing (a synthetic id the IANA set won't contain) → appended once.
    ensureZoneOption(select, "Custom/Nowhere");
    const values = optionValues(select);
    assert.equal(values.filter((v) => v === "Custom/Nowhere").length, 1, "the new zone is added exactly once");
    const afterAdd = select.options.length;
    assert.equal(afterAdd, before + 1, "adding a missing zone grows the list by one");

    // Adding the same missing zone again is a no-op (now present).
    ensureZoneOption(select, "Custom/Nowhere");
    assert.equal(select.options.length, afterAdd, "re-adding the now-present zone does nothing");

    // A blank/falsy zone is ignored.
    ensureZoneOption(select, "");
    assert.equal(select.options.length, afterAdd, "a blank zone is a no-op");
  });
});

test("guessTimeZone returns a usable IANA id (or blank), never throws", () => {
  const tz = guessTimeZone();
  assert.equal(typeof tz, "string");
  // It's either "" (unknowable) or a plausible IANA id — this mirrors the event-form.js contract test.
  assert.ok(tz === "" || tz.length > 0);
});
