// Dialog-hardening regression tests (TM-947) — follow-ons from the TM-906 aria-modal review.
//
// These drive the REAL confirmDialog() / modal() / toast() code from ui.js against a small functional
// fake DOM (no jsdom — CI pins Node 20, node: built-ins only), so the behaviours live on the PR gate:
//
//   • Item 1a — a toast fired WHILE a confirm is open must be inerted (not left tabbable behind the
//     backdrop). Proven by a MutationObserver-on-body that inerts late siblings. Fails before the fix
//     (the original sweep ran once at open, so a later toast host stayed live).
//   • Item 1b — a PRE-EXISTING #tm-toasts host must NOT be inerted (persistent toasts stay clickable
//     under a confirm — they sit on the modal layer). Fails before the fix (the sweep inerted it).
//   • Item 3 — modal() must trap focus inside the dialog and restore focus to the opener on close, the
//     same as confirmDialog, via the shared helper. Fails before the fix (modal() had no trap/restore).
//
// ui.js is directly importable in Node — it is framework-free with no `https:` Firebase import chain —
// so we run the actual module against `globalThis.document` / `globalThis.MutationObserver` fakes that
// record inert/aria-hidden/focus and deliver childList mutations synchronously on append.

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

// ── A minimal functional DOM ─────────────────────────────────────────────────────────────────────
// Enough of Element/Document for ui.js: an element tree with append/remove, attributes, inert as a
// live property, class/dataset, event listeners, focus() + document.activeElement + contains(), and
// querySelectorAll for the focus-trap ring. A body-scoped MutationObserver delivers `childList`
// records synchronously whenever a child is appended/removed — the seam item 1a's live inert relies on.

let mutationObservers = []; // every observer currently watching (so append can notify body-watchers)

function makeEl(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    parentNode: null,
    childNodes: [],
    attributes: {},
    className: "",
    dataset: {},
    listeners: {},
    inert: false,
    id: "",
    _focused: false,

    get children() {
      return this.childNodes.filter((c) => c.nodeType === 1);
    },
    get firstChild() {
      return this.childNodes[0] || null;
    },
    setAttribute(name, value) {
      if (name === "id") this.id = String(value);
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      if (name === "id") return this.id || null;
      if (name === "class") return this.className || null; // el() sets .className, mirrors class attr
      return name in this.attributes ? this.attributes[name] : null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    hasAttribute(name) {
      return name in this.attributes;
    },
    append(...kids) {
      for (const kid of kids) this._insert(kid);
    },
    appendChild(kid) {
      this._insert(kid);
      return kid;
    },
    _insert(kid) {
      const child = kid && kid.nodeType ? kid : makeText(String(kid));
      child.parentNode = this;
      this.childNodes.push(child);
      notifyChildListAdded(this, child);
    },
    remove() {
      const p = this.parentNode;
      if (!p) return;
      const i = p.childNodes.indexOf(this);
      if (i !== -1) p.childNodes.splice(i, 1);
      this.parentNode = null;
      notifyChildListRemoved(p, this);
    },
    removeChild(kid) {
      const i = this.childNodes.indexOf(kid);
      if (i !== -1) this.childNodes.splice(i, 1);
      kid.parentNode = null;
      return kid;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = this.listeners[type];
      if (arr) this.listeners[type] = arr.filter((f) => f !== fn);
    },
    dispatch(type, event = {}) {
      (this.listeners[type] ?? []).forEach((fn) => fn(event));
    },
    focus() {
      doc.activeElement = this;
      this._focused = true;
    },
    contains(other) {
      if (!other) return false;
      if (other === this) return true;
      return this.children.some((c) => c.contains(other));
    },
    // Very small selector engine: only the token forms ui.js's focus-trap ring uses (tag[:not] +
    // [tabindex]). We treat every enabled <button>/<a>/<input> as focusable and skip tabindex=-1.
    querySelectorAll() {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (isFocusable(c)) out.push(c);
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
      if (v !== "") this._insert(makeText(String(v)));
    },
    get textContent() {
      return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join("");
    },
    style: {},
  };
  return node;
}

function isFocusable(node) {
  if (node.nodeType !== 1) return false;
  const focusableTags = ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"];
  if (node.getAttribute("tabindex") === "-1") return false;
  if (focusableTags.includes(node.tagName) && !node.hasAttribute("disabled")) return true;
  return node.hasAttribute("tabindex");
}

function makeText(str) {
  return { nodeType: 3, data: String(str), parentNode: null, contains: () => false };
}

function notifyChildListAdded(parent, child) {
  for (const o of mutationObservers) {
    if (o.target === parent && o.opts.childList) o.cb([{ addedNodes: [child], removedNodes: [] }]);
  }
}
function notifyChildListRemoved(parent, child) {
  for (const o of mutationObservers) {
    if (o.target === parent && o.opts.childList) o.cb([{ addedNodes: [], removedNodes: [child] }]);
  }
}

class FakeMutationObserver {
  constructor(cb) {
    this.cb = cb;
    this.target = null;
    this.opts = null;
  }
  observe(target, opts) {
    this.target = target;
    this.opts = opts;
    mutationObservers.push(this);
  }
  disconnect() {
    mutationObservers = mutationObservers.filter((o) => o !== this);
  }
}

let doc;

function installDom() {
  mutationObservers = [];
  const body = makeEl("body");
  doc = {
    body,
    activeElement: null,
    _byId: {},
    createElement: (tag) => makeEl(tag),
    createTextNode: (str) => makeText(str),
    getElementById(id) {
      const find = (n) => {
        for (const c of n.children) {
          if (c.id === id) return c;
          const hit = find(c);
          if (hit) return hit;
        }
        return null;
      };
      return find(body);
    },
    contains(node) {
      return node ? body.contains(node) : false;
    },
    addEventListener(type, fn) {
      (this._docListeners ??= {})[type] = (this._docListeners?.[type] || []).concat(fn);
    },
    removeEventListener(type, fn) {
      if (this._docListeners?.[type]) this._docListeners[type] = this._docListeners[type].filter((f) => f !== fn);
    },
    dispatch(type, event = {}) {
      (this._docListeners?.[type] || []).forEach((fn) => fn(event));
    },
  };
  globalThis.document = doc;
  globalThis.MutationObserver = FakeMutationObserver;
  return doc;
}

installDom();
const ui = await import("../src/assets/ui.js");
const { confirmDialog, modal, toast } = ui;

beforeEach(() => installDom());

/** Fire a keydown at the document (what ui.js listens on). */
function key(name, extra = {}) {
  doc.dispatch("keydown", { key: name, preventDefault() { this._prevented = true; }, ...extra });
}

// ── Item 1a — a sibling mounted WHILE a confirm is open must be inerted (via the MutationObserver) ──
//
// The mechanism the ticket resolves 1a with: a MutationObserver on <body> inerts siblings that mount
// AFTER the dialog opened (the original sweep ran once at open, so a late sibling stayed tabbable
// behind the backdrop). The #tm-toasts host is the one exception — it JOINS the modal layer (exempt
// from inert, rendered above the backdrop, interactive) rather than being stuck behind it.

test("item 1a: a non-toast sibling mounted while a confirm is open is inerted (live MutationObserver)", () => {
  // A page control that exists before the dialog opens — the baseline once-at-open sweep inerts it.
  const pageControl = ui.el("button", { id: "page-ctl" }, "Do thing");
  doc.body.append(pageControl);

  confirmDialog({ title: "Sure?" });
  assert.equal(pageControl.inert, true, "the pre-existing page control is inerted by the open sweep");

  // A NEW background sibling mounts WHILE the confirm is up (e.g. some page-level render). It must be
  // inerted too, or its buttons stay tabbable behind the backdrop. Before TM-947 the sweep only ran
  // once at open, so nothing inerted this late sibling → RED.
  const lateSibling = ui.el("div", { id: "late-panel" }, [ui.el("button", { id: "late-btn" }, "Late")]);
  doc.body.append(lateSibling);
  assert.equal(lateSibling.inert, true, "a sibling mounted during a confirm must be inerted by the body observer");

  // And the toast host, when a toast fires mid-dialog, is EXEMPT — it joins the modal layer (item 1b's
  // fix, applied to the live path too), so it is NOT inerted behind the dialog.
  toast("Saved.", { timeout: 0 });
  const host = doc.getElementById("tm-toasts");
  assert.ok(host, "toast host was created mid-dialog");
  assert.equal(host.inert, false, "a toast host mounted mid-dialog joins the modal layer (NOT inerted)");
});

// ── Item 1b — a PRE-EXISTING toast host must NOT go click-dead under a confirm ────────────────────

test("item 1b: a persistent toast present before the confirm stays clickable (not inerted)", () => {
  // A persistent toast exists first — the foreground-push card pattern (timeout: 0).
  toast("Incoming push", { timeout: 0 });
  const host = doc.getElementById("tm-toasts");
  assert.ok(host, "toast host exists before the dialog");

  let clicked = false;
  const actionBtn = ui.el("button", { onClick: () => { clicked = true; } }, "Open");
  host.children[0].append(actionBtn);

  confirmDialog({ title: "Sure?" });

  // THE CONTRACT: the toast host is exempt from the inert sweep, so its buttons stay live. Before
  // TM-947 the sweep inerted every body child except the backdrop, so the toast went click-dead → RED.
  assert.equal(host.inert, false, "the pre-existing toast host must NOT be inerted during a confirm");

  actionBtn.dispatch("click", {});
  assert.equal(clicked, true, "the persistent toast's action button is still clickable during the confirm");
});

// ── Item 3 — modal() must trap focus + restore focus, via the shared helper ───────────────────────

test("item 3: modal() inerts the background and restores focus to the opener on close", () => {
  const opener = ui.el("button", { id: "opener" }, "Open modal");
  doc.body.append(opener);
  opener.focus();
  assert.equal(doc.activeElement, opener, "opener has focus before modal opens");

  const bg = ui.el("button", { id: "bg" }, "Background");
  doc.body.append(bg);

  const { close } = modal("My modal", [ui.el("button", { id: "modal-inner" }, "Inner")]);

  // Background is inert (parity with confirmDialog). Before TM-947 modal() inerted nothing → RED.
  assert.equal(bg.inert, true, "modal() must inert background siblings");
  // Focus was seated inside the dialog on open (it left the opener).
  assert.notEqual(doc.activeElement, opener, "focus moved off the opener into the modal");

  close();
  // Focus is restored to the opener on close. Before TM-947 modal() had no restore → RED.
  assert.equal(doc.activeElement, opener, "modal() must restore focus to the opener on close");
  assert.equal(bg.inert, false, "background inert is cleared on close");
});

test("item 3: modal() traps Tab inside the dialog (Tab off the last focusable wraps to the first)", () => {
  const bg = ui.el("button", { id: "bg" }, "Background");
  doc.body.append(bg);

  modal("Trap", [ui.el("button", { id: "m-a" }, "A"), ui.el("button", { id: "m-b" }, "B")]);

  // Put focus on the LAST focusable in the dialog, then press Tab → the trap must wrap to the first,
  // never letting focus escape to the background button. Before TM-947 modal() had no keydown trap,
  // so Tab was a no-op here and focus could reach `bg` → RED.
  const focusables = openDialogFocusables();
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  last.focus();
  assert.equal(doc.activeElement, last, "seated focus on the last focusable");

  key("Tab");
  assert.equal(doc.activeElement, first, "Tab on the last focusable wraps to the first (trapped)");
  assert.notEqual(doc.activeElement, bg, "focus never escapes to the background");

  // And Shift+Tab off the first wraps back to the last.
  first.focus();
  key("Tab", { shiftKey: true });
  assert.equal(doc.activeElement, last, "Shift+Tab on the first focusable wraps to the last");
});

/** The focusable elements inside the currently-open (topmost) modal dialog. */
function openDialogFocusables() {
  const backdrops = doc.body.children.filter((c) => (c.className || "").includes("tm-backdrop"));
  const backdrop = backdrops[backdrops.length - 1];
  const dialog = backdrop.children.find((c) => (c.className || "").includes("tm-dialog"));
  return dialog.querySelectorAll("button");
}

// ── Item 2 — stacking: only the topmost dialog reacts to Escape ───────────────────────────────────

test("item 2: with two dialogs stacked, Escape closes only the topmost", async () => {
  const outer = modal("Outer", [ui.el("button", { id: "outer-btn" }, "outer")]);
  let innerResolved = false;
  const innerPromise = confirmDialog({ title: "Inner" }).then(() => { innerResolved = true; });

  // Two backdrops on the body now (outer modal + inner confirm).
  const backdrops = () => doc.body.children.filter((c) => (c.className || "").includes("tm-backdrop"));
  assert.equal(backdrops().length, 2, "both dialogs are mounted");

  // Escape must close ONLY the frontmost (the confirm), leaving the outer modal open.
  key("Escape");
  await innerPromise;
  assert.equal(innerResolved, true, "the topmost (inner confirm) closed on Escape");
  assert.equal(backdrops().length, 1, "exactly one dialog closed — the outer modal is still open");

  void outer;
});
