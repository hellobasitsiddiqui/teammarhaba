// Recovery-bell dedupe guard (TM-561). Framework-free — Node's built-in test runner, picked up by
// the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG: on the native shell, a foreground push made notification-center.js (the TM-374 recovery
// bell) self-mount a `#tm-notif-bell` button (class `.tm-notif-bell`) into `nav.app-nav` — right next
// to the TM-455 static `#nav-notif-bell` (which carries the SAME `.tm-notif-bell` class). Two
// identical bells side-by-side.
//
// THE FIX (TM-561): when the static bell is present it owns the header notification-bell surface, so
// the recovery bell no longer mounts. The foreground-push REFRESH is kept — notifyForegroundPush
// still dispatches the `tm:notification` window event the static bell listens for.
//
// notification-center.js uses the GLOBAL `document`/`window`, so this drives it with a tiny fake DOM
// (no jsdom in the repo — same "hand-rolled minimal DOM" approach as appearance-core.test.mjs). It's
// a real behavioural test: it mounts, then COUNTS the `.tm-notif-bell` controls in the nav.

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

import { notifyForegroundPush, initNotificationCenter } from "../src/assets/notification-center.js";

// ── A minimal fake DOM — only the surface notification-center.js + ui.js's el()/toast() touch. ──────

/** Match a node against a simple `tag`, `.class`, or `tag.class` selector. */
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
  get id() {
    return this.attributes.id ?? "";
  }
  set id(v) {
    this.attributes.id = v;
  }
  get hidden() {
    return this.attributes.hidden === true;
  }
  set hidden(v) {
    this.attributes.hidden = !!v;
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
  getAttribute(k) {
    return this.attributes[k] ?? null;
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
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
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
let dispatched; // captured `tm:notification` events

/** Fresh document/window globals + a `nav.app-nav` under body. Returns the nav. */
function freshDom({ withStaticBell }) {
  const body = new FakeElement("body");
  doc = {
    createElement: (t) => new FakeElement(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
    getElementById: (id) => [...descendants(body)].find((n) => n.attributes.id === id) ?? null,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    body,
    addEventListener() {},
    removeEventListener() {},
  };

  const nav = new FakeElement("nav");
  nav.className = "app-nav";
  body.append(nav);

  if (withStaticBell) {
    // Mirror index.html's TM-455 static bell: id nav-notif-bell + the shared .tm-notif-bell class.
    const staticBell = new FakeElement("button");
    staticBell.id = "nav-notif-bell";
    staticBell.className = "tm-notif-bell";
    const chip = new FakeElement("span");
    chip.className = "tm-notif-badge";
    staticBell.append(chip);
    nav.append(staticBell);
  }

  dispatched = [];
  const storage = (() => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  })();

  global.document = doc;
  global.window = {
    localStorage: storage,
    dispatchEvent: (ev) => {
      dispatched.push(ev);
      return true;
    },
    location: { hash: "" },
  };
  // Re-hydrate the module's in-memory inbox from the fresh (empty) storage so tests are independent.
  initNotificationCenter();
  return nav;
}

beforeEach(() => {
  // ensure a clean slate even if a prior file left globals (node --test isolates files, belt+braces)
  delete global.document;
  delete global.window;
});

afterEach(() => {
  delete global.document;
  delete global.window;
});

const PUSH = { title: "Flash event", body: "Free dinner tonight", data: { route: "#/home" } };

test("static bell present: the recovery bell does NOT mount — only ONE .tm-notif-bell in the nav", () => {
  const nav = freshDom({ withStaticBell: true });

  notifyForegroundPush(PUSH);

  const bells = nav.querySelectorAll(".tm-notif-bell");
  assert.equal(bells.length, 1, "exactly one bell control must remain (the static #nav-notif-bell)");
  assert.equal(bells[0].id, "nav-notif-bell", "the surviving bell is the TM-455 static one");
  assert.equal(doc.getElementById("tm-notif-bell"), null, "the TM-374 recovery bell must not be mounted");
});

test("static bell present: the foreground-push REFRESH is still kept (tm:notification dispatched)", () => {
  freshDom({ withStaticBell: true });

  notifyForegroundPush(PUSH);

  const refresh = dispatched.find((ev) => ev.type === "tm:notification");
  assert.ok(refresh, "notifyForegroundPush must still dispatch tm:notification so the static bell refreshes");
  assert.equal(refresh.detail?.source, "foreground-push", "the refresh signal carries its source");
});

test("no static bell (legacy web build): the recovery bell still mounts as before (gate is conditional)", () => {
  const nav = freshDom({ withStaticBell: false });

  notifyForegroundPush(PUSH);

  const bells = nav.querySelectorAll(".tm-notif-bell");
  assert.equal(bells.length, 1, "without a static bell the recovery bell provides the one bell");
  assert.equal(bells[0].id, "tm-notif-bell", "the mounted bell is the TM-374 recovery bell");
});

test("static bell present: a stray recovery bell (mounted pre-static) is removed on repaint (defensive)", () => {
  const nav = freshDom({ withStaticBell: false });
  // Mount the recovery bell first (no static bell yet)...
  notifyForegroundPush(PUSH);
  assert.ok(doc.getElementById("tm-notif-bell"), "precondition: recovery bell mounted while static bell absent");

  // ...then the static bell appears (index.html markup parses / late reconciliation) and a repaint runs.
  const staticBell = new FakeElement("button");
  staticBell.id = "nav-notif-bell";
  staticBell.className = "tm-notif-bell";
  nav.append(staticBell);

  // A DISTINCT push (different title/body/route so it isn't deduped) → notifyForegroundPush repaints.
  notifyForegroundPush({ title: "Second event", body: "Another ping", data: { route: "#/profile" } });

  assert.equal(doc.getElementById("tm-notif-bell"), null, "the stray recovery bell is removed once the static bell exists");
  const bells = nav.querySelectorAll(".tm-notif-bell");
  assert.equal(bells.length, 1, "only the static bell remains");
  assert.equal(bells[0].id, "nav-notif-bell");
});
