// Receipts blank-slate (empty-state) render guard (TM-762 / part of the TM-738 P2 membership backlog).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// membership-receipts.js imports ONLY ui.js (never api.js → the Firebase CDN), so its DOM painters CAN
// load + run under `node --test` against a tiny hand-rolled DOM — the same "no jsdom in the repo"
// approach as notification-center-bell-gate.test.mjs / appearance-core.test.mjs. The pure helpers
// (statusMeta / formatAmount / normalizeOrders / receiptLines / loadOrders) are already exhaustively
// covered in membership-receipts.test.mjs; this file adds the ONE painter-level behaviour that suite
// doesn't touch: the empty-state "blank slate" (the AC's "empty ... state").
//
// WHY this is worth a P2 test: renderList branches on `orders.length === 0` to paint a distinct
// no-purchases blank slate (title + explanatory body + NO order rows) instead of an empty list. That
// zero-data screen is what a brand-new / never-purchased caller sees, and nothing else pins that it
// (a) shows the blank-slate copy and (b) renders zero clickable `.tm-receipt-row` buttons. It asserts
// existing behaviour → it must pass green (no source change).

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

import { renderList } from "../src/assets/membership-receipts.js";

// ── A minimal fake DOM — only the surface ui.js's el()/clear() + renderList touch. ──────────────────

/** Match a node against a simple `tag`, `.class`, or `tag.class` selector (enough for these asserts). */
function matchesSelector(node, sel) {
  const m = String(sel).match(/^([a-zA-Z][\w-]*)?(?:\.([\w-]+))?$/);
  if (!m) return false;
  const [, tag, cls] = m;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (cls && !String(node.className).split(/\s+/).includes(cls)) return false;
  return true;
}

/** Depth-first walk of an element's descendants (self excluded, DOM-like). */
function* descendants(node) {
  for (const child of node.children) {
    if (child.nodeType !== 1) continue;
    yield child;
    yield* descendants(child);
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.className = "";
    this._text = "";
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
    this.children = []; // textContent replaces children, DOM-like
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === "string" ? doc.createTextNode(n) : n;
      node.parentNode = this;
      this.children.push(node);
    }
  }
  // renderList paints via container.appendChild(...) (ui.js's el() uses .append internally).
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
  }
  querySelector(sel) {
    for (const n of descendants(this)) if (matchesSelector(n, sel)) return n;
    return null;
  }
  querySelectorAll(sel) {
    return [...descendants(this)].filter((n) => matchesSelector(n, sel));
  }
}

let doc; // reset per test

beforeEach(() => {
  doc = {
    createElement: (t) => new FakeElement(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
  };
  global.document = doc; // ui.js's el() uses the global document
});

afterEach(() => {
  delete global.document;
});

/** The screen section renderList paints into. */
function freshContainer() {
  return new FakeElement("section");
}

// --- the empty-state blank slate -----------------------------------------------------------------

test("renderList with NO orders paints the no-purchases blank slate, not an empty list", () => {
  const container = freshContainer();
  renderList(container, [], {});

  // The zero-data state is a distinct `.tm-receipts-empty` block, NOT the `.tm-receipts-list`.
  const empty = container.querySelector(".tm-receipts-empty");
  assert.ok(empty, "an empty order set must render the blank-slate block");
  assert.equal(container.querySelector(".tm-receipts-list"), null, "no order list is rendered when empty");

  // It carries a headline + an explanatory body (a real blank slate = explanation, not a bare title).
  assert.equal(
    container.querySelector(".tm-receipts-empty-title").textContent,
    "No purchases yet",
    "the blank slate headlines that there are no purchases",
  );
  assert.equal(
    container.querySelector(".tm-receipts-empty-body").textContent,
    "Events you register for and pay for will show up here.",
    "the blank slate explains where purchases will appear",
  );

  // And the screen title is still present above the blank slate.
  assert.equal(
    container.querySelector(".tm-receipts-title").textContent,
    "My tickets & purchases",
    "the screen title is still shown above the blank slate",
  );
});

test("the blank slate renders zero clickable order rows (nothing to open)", () => {
  const container = freshContainer();
  renderList(container, [], {});
  assert.equal(
    container.querySelectorAll(".tm-receipt-row").length,
    0,
    "there must be no clickable purchase rows in the empty state",
  );
});

test("a nullish order set is treated as empty (defensive) — same blank slate, never a throw", () => {
  const container = freshContainer();
  assert.doesNotThrow(() => renderList(container, undefined, {}));
  assert.ok(container.querySelector(".tm-receipts-empty"), "a nullish list falls back to the blank slate");
  assert.equal(container.querySelector(".tm-receipts-list"), null, "no list block for a nullish order set");
});
