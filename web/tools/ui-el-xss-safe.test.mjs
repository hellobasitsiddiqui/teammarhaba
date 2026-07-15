// P0 shell coverage — the reusable DOM primitive `el()` is XSS-safe by construction (TM-738).
//
// WHY THIS IS A P0 (security-negative). `ui.js` (TM-133) is the shell's single, framework-free DOM
// builder — every page (admin console, toasts, dialogs, modals) paints untrusted strings (emails,
// display names, alert copy) through `el(tag, { text }, children)`. Its whole security contract is
// STRUCTURAL: it only ever sets untrusted text via `textContent` and appends string children as
// `document.createTextNode(...)` — there is deliberately NO `innerHTML` / `insertAdjacentHTML` seam, so
// a value like `<img src=x onerror=alert(1)>` can never be parsed as markup. If a later edit slipped an
// `innerHTML =` assignment into `el()`, stored-XSS would open across every surface at once. This module
// had ZERO test coverage before this file — the highest-leverage shell gap in the audit.
//
// Framework-free, no jsdom (CI pins Node 20, only stable node: built-ins): we drive `el()` against a
// minimal hand-rolled fake `document` that records exactly which sink each value lands in (the
// appearance-core.test.mjs fake-DOM pattern), so we can assert untrusted strings reach `textContent` /
// a text node and never an HTML-parsing sink. A companion source-guard pins that `ui.js` never grows an
// innerHTML seam. Picked up by the CI glob `node --test web/tools/*.test.mjs`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- A minimal fake DOM: enough of Node/Element for el() to run, recording every write ----------------
//
// Crucially it has NO HTML parser: `textContent` and text-node `data` are stored as OPAQUE strings, so a
// markup-looking value can only ever become inert text — mirroring the real browser's textContent sink.
// If el() ever routed a value through an innerHTML-style sink, this fake has none, so it would throw —
// the test would go red instead of silently letting markup through.

/** A fake text node — its `data` is opaque text, never parsed. */
function fakeTextNode(str) {
  return { nodeType: 3, data: String(str) };
}

/** A fake element that records attributes / text / class / dataset / listeners / appended children. */
function fakeElement(tag) {
  return {
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
      // The browser's real textContent sink: the assigned string is stored verbatim as text — it is
      // NEVER interpreted as HTML. We record it so the test can prove untrusted strings land here.
      this._textContent = String(v);
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
    append(...nodes) {
      for (const n of nodes) this.children.push(n);
    },
  };
}

/** Install a fake `document` on globalThis for the duration of a callback, then restore it. */
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

// el() reads `document` at call time, so import the module fresh AFTER we can guarantee the fake is in
// place per-test. It has no top-level DOM access, so a plain import is safe.
const { el, clear } = await import("../src/assets/ui.js");

// A classic stored-XSS payload — a name/email an attacker might set on their profile.
const XSS = `<img src=x onerror="alert(document.cookie)">`;

// --- Behavioural: untrusted `text` lands in textContent, never an HTML sink -------------------------

test("el() routes an untrusted `text` prop into textContent verbatim (no markup parsing)", () => {
  withFakeDocument(() => {
    const node = el("span", { text: XSS });
    // The malicious string is stored as inert text on the textContent sink...
    assert.equal(node.textContent, XSS, "the payload is preserved as literal text content");
    // ...and NOT as any child element (it never parsed into an <img> node).
    assert.equal(node.children.length, 0, "no markup was parsed into child element nodes");
  });
});

test("el() appends a string child as a TEXT node, never parsed markup", () => {
  withFakeDocument(() => {
    const node = el("div", {}, [XSS]);
    assert.equal(node.children.length, 1, "exactly one child was appended");
    const child = node.children[0];
    assert.equal(child.nodeType, 3, "the string child is a text node (nodeType 3), not an element");
    assert.equal(child.data, XSS, "the text node holds the payload as inert text");
  });
});

test("el() sets a non-text attribute via setAttribute as a plain string (no code path to HTML)", () => {
  withFakeDocument(() => {
    const node = el("a", { href: "https://example.test", title: XSS });
    assert.equal(node.getAttribute("href"), "https://example.test");
    // Even a hostile attribute VALUE is set as an opaque string attribute — it can't break out into markup.
    assert.equal(node.getAttribute("title"), XSS);
  });
});

// --- Behavioural: the documented prop specials still work (so the safe path is the only path) --------

test("el() maps class / dataset / on<Event> / boolean props to the right safe sinks", () => {
  withFakeDocument(() => {
    let clicked = 0;
    const node = el("button", {
      class: "tm-btn",
      dataset: { userId: "u-1" },
      type: "button",
      disabled: true, // boolean true → bare attribute
      hidden: false, // boolean false → omitted
      onClick: () => {
        clicked += 1;
      },
    });
    assert.equal(node.className, "tm-btn", "class → className");
    assert.equal(node.dataset.userId, "u-1", "dataset object → element.dataset");
    assert.equal(node.getAttribute("type"), "button");
    assert.equal(node.getAttribute("disabled"), "", "boolean true → bare (empty-string) attribute");
    assert.equal(node.getAttribute("hidden"), null, "boolean false → attribute omitted");
    // on<Event> registered a listener (not an inline on* attribute string, which would be an injection sink).
    assert.equal(node.getAttribute("onclick"), null, "no inline on* ATTRIBUTE was set");
    assert.equal((node.listeners.click || []).length, 1, "onClick was registered via addEventListener");
    node.listeners.click[0]();
    assert.equal(clicked, 1, "the registered listener fires");
  });
});

test("el() skips null/undefined props and null children (defensive, no throw)", () => {
  withFakeDocument(() => {
    const node = el("div", { class: null, title: undefined }, [null, "kept", undefined]);
    assert.equal(node.getAttribute("class"), null, "null prop skipped");
    assert.equal(node.getAttribute("title"), null, "undefined prop skipped");
    assert.equal(node.children.length, 1, "null/undefined children are dropped, the real one kept");
    assert.equal(node.children[0].data, "kept");
  });
});

test("clear() removes all children without touching innerHTML", () => {
  // clear() is the safe replacement for `innerHTML = ""`; prove it empties via node removal.
  const parent = {
    kids: ["a", "b", "c"],
    get firstChild() {
      return this.kids.length ? this.kids[0] : null;
    },
    removeChild(_c) {
      this.kids.shift();
    },
  };
  const returned = clear(parent);
  assert.equal(parent.kids.length, 0, "all children removed");
  assert.equal(returned, parent, "clear returns the node for chaining");
});

// --- Source guard: ui.js must NEVER grow an innerHTML / HTML-parsing seam --------------------------

test("ui.js has NO innerHTML / insertAdjacentHTML / outerHTML sink anywhere (structural XSS safety)", () => {
  const RAW = readFileSync(join(HERE, "../src/assets/ui.js"), "utf8");
  // Strip comments before scanning: ui.js's own docstring legitimately NAMES `innerHTML` in prose
  // ("intentionally no innerHTML seam") — we guard the executable CODE, not the documentation that
  // explains the guarantee. Drop block comments (/* … */) and line comments (// …) so a match means a
  // real sink in the code, not a mention in a comment.
  const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.doesNotMatch(
      CODE,
      new RegExp(sink.replace(".", "\\.")),
      `ui.js code must not use ${sink} — el()'s XSS-safety is that the only sink is textContent / createTextNode`,
    );
  }
  // Positive assertion: the safe sinks the module is built on are present in the code.
  assert.match(CODE, /textContent/, "el() sets text via textContent");
  assert.match(CODE, /createTextNode/, "string children are appended as text nodes");
});
