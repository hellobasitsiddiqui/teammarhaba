// Tests for the shared UI component library (TM-511). Framework-free — Node's built-in test runner,
// picked up by the CI glob `node --test web/tools/*.test.mjs` (same harness as the other web tests).
//
// Two things the ticket asks us to prove:
//   1. COMPONENT RENDER — each builder produces the right element, classes, structure, a11y
//      attributes and interaction behaviour. The app is framework-free and there is no jsdom in the
//      toolchain, so we install a TINY DOM shim (below) — just enough of the DOM surface that ui.js's
//      `el()` and these builders touch — and assert on the real node tree they build.
//   2. TOKEN-DRIVEN RESTYLE — the components consume design tokens ONLY (no hard-coded colours), so a
//      theme flip is a pure token swap. We parse the TM-511 block of the real stylesheet and assert
//      it carries no raw hex/rgb() colour and that the state rules resolve to var(--…) tokens.
//
// The pure read-receipt descriptor (incl. the TM-433 whole-group-read triple-tick) is tested without
// a DOM, mirroring the account-badges.js pattern (logic in a pure fn, the renderer a thin map).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ─────────────────────────────────────── minimal DOM shim ───────────────────────────────────────
 * A node implements exactly the surface `el()` (ui.js) + the builders use: className, dataset,
 * get/set/hasAttribute, addEventListener, append, remove(Child), firstChild, children, classList,
 * textContent (aggregated from children), plus a `fire()` test helper to dispatch a listener. */
function makeText(str) {
  return { nodeType: 3, _t: String(str), get textContent() { return this._t; }, set textContent(v) { this._t = String(v); } };
}

function makeEl(tagName) {
  return {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    className: "",
    dataset: {},
    style: {},
    parentNode: null,
    _attrs: {},
    _children: [],
    _listeners: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    hasAttribute(k) { return k in this._attrs; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    append(...kids) {
      for (const kid of kids) {
        const c = kid && kid.nodeType ? kid : makeText(String(kid));
        c.parentNode = this;
        this._children.push(c);
      }
    },
    removeChild(c) {
      const i = this._children.indexOf(c);
      if (i >= 0) this._children.splice(i, 1);
      return c;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    get firstChild() { return this._children[0] || null; },
    get children() { return this._children.filter((c) => c.nodeType === 1); },
    get childNodes() { return this._children.slice(); },
    get classList() {
      const self = this;
      const parts = () => self.className.split(/\s+/).filter(Boolean);
      return {
        contains: (c) => parts().includes(c),
        add: (...cs) => { const s = new Set(parts()); cs.forEach((c) => s.add(c)); self.className = [...s].join(" "); },
        remove: (...cs) => { const s = new Set(parts()); cs.forEach((c) => s.delete(c)); self.className = [...s].join(" "); },
      };
    },
    get textContent() { return this._children.map((c) => c.textContent).join(""); },
    set textContent(v) { this._children = [makeText(v)]; },
    // Test helper: invoke the registered listeners for an event type.
    fire(type, evt = {}) {
      for (const fn of this._listeners[type] || []) fn({ type, target: this, stopPropagation() {}, preventDefault() {}, ...evt });
    },
  };
}

globalThis.document = {
  createElement: (t) => makeEl(t),
  createTextNode: (s) => makeText(s),
  body: makeEl("body"),
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
};

/** Depth-first: the first descendant (or self) whose classList contains `cls`. */
function findByClass(node, cls) {
  if (node.nodeType === 1 && node.classList.contains(cls)) return node;
  for (const c of node.childNodes || []) {
    if (c.nodeType !== 1) continue;
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

/** All descendants (incl. self) whose classList contains `cls`. */
function allByClass(node, cls, acc = []) {
  if (node.nodeType === 1 && node.classList.contains(cls)) acc.push(node);
  for (const c of node.childNodes || []) if (c.nodeType === 1) allByClass(c, cls, acc);
  return acc;
}

// Import AFTER the shim is installed. (Imports are hoisted, but the builders only touch `document`
// at call time, so this is belt-and-braces.)
const C = await import("../src/assets/components.js");

/* ───────────────────────────────────────── buttons ───────────────────────────────────────────── */

test("button: variant + size map to the token-styled classes; disabled + type honoured", () => {
  const primary = C.button("Save");
  assert.equal(primary.tagName, "BUTTON");
  assert.equal(primary.getAttribute("type"), "button");
  assert.ok(primary.classList.contains("tm-btn") && primary.classList.contains("tm-btn-primary"));
  assert.equal(primary.textContent, "Save");

  assert.ok(C.button("x", { variant: "ghost" }).classList.contains("tm-btn-ghost"));
  assert.ok(C.button("x", { variant: "danger" }).classList.contains("tm-btn-danger"));
  // neutral = the bare surface button, no fill modifier.
  const neutral = C.button("x", { variant: "neutral" });
  assert.ok(neutral.classList.contains("tm-btn"));
  assert.ok(!neutral.classList.contains("tm-btn-primary"));

  const small = C.button("x", { size: "sm", disabled: true });
  assert.ok(small.classList.contains("tm-btn-sm"));
  assert.ok(small.hasAttribute("disabled"));
});

test("button: onClick fires", () => {
  let clicked = 0;
  const b = C.button("Go", { onClick: () => { clicked++; } });
  b.fire("click");
  assert.equal(clicked, 1);
});

/* ─────────────────────────────────────── tags & chips ────────────────────────────────────────── */

test("tag: static label with the variant class", () => {
  assert.ok(C.tag("Padel").classList.contains("tm-tag"));
  assert.ok(C.tag("Padel", { variant: "accent" }).classList.contains("tm-tag-accent"));
  assert.equal(C.tag("Padel").textContent, "Padel");
});

test("chip: selectable toggles aria-pressed + notifies; removable detaches + notifies", () => {
  let toggled = null;
  const c = C.chip("Sport", { value: "sport", onToggle: (sel, v) => { toggled = [sel, v]; } });
  assert.equal(c.getAttribute("aria-pressed"), "false");
  c.fire("click");
  assert.equal(c.getAttribute("aria-pressed"), "true");
  assert.deepEqual(toggled, [true, "sport"]);

  let removed = null;
  const host = makeEl("div");
  const r = C.chip("Food", { value: "food", removable: true, onRemove: (v) => { removed = v; } });
  host.append(r);
  const x = findByClass(r, "tm-chip-remove");
  assert.ok(x, "removable chip has a remove control");
  x.fire("click");
  assert.equal(removed, "food");
  assert.equal(host.children.length, 0, "removed chip detached from its parent");
});

/* ───────────────────────────────────── segmented control ─────────────────────────────────────── */

test("segmented: renders a radiogroup; selecting updates aria-checked + dataset + fires onChange", () => {
  let changed = null;
  const seg = C.segmented(
    [{ value: "up", label: "Upcoming" }, { value: "past", label: "Past" }],
    { onChange: (v) => { changed = v; } },
  );
  assert.equal(seg.getAttribute("role"), "radiogroup");
  const radios = allByClass(seg, "tm-segment");
  assert.equal(radios.length, 2);
  // first is selected by default
  assert.equal(seg.dataset.value, "up");
  assert.equal(radios[0].getAttribute("aria-checked"), "true");
  assert.equal(radios[1].getAttribute("aria-checked"), "false");
  // pick the second
  radios[1].fire("click");
  assert.equal(changed, "past");
  assert.equal(seg.dataset.value, "past");
  assert.equal(radios[0].getAttribute("aria-checked"), "false");
  assert.equal(radios[1].getAttribute("aria-checked"), "true");
});

/* ──────────────────────────────────────────── toggle ─────────────────────────────────────────── */

test("toggle: role=switch, aria-checked flips on click, onChange gets the new value", () => {
  let val = null;
  const sw = C.toggle({ checked: false, ariaLabel: "Notifications", onChange: (v) => { val = v; } });
  assert.equal(sw.getAttribute("role"), "switch");
  assert.equal(sw.getAttribute("aria-checked"), "false");
  sw.fire("click");
  assert.equal(sw.getAttribute("aria-checked"), "true");
  assert.equal(val, true);
});

test("toggle: with a label wraps the switch in a label element", () => {
  const field = C.toggle({ label: "Dark mode" });
  assert.equal(field.tagName, "LABEL");
  assert.ok(findByClass(field, "tm-toggle"), "switch is inside the labelled field");
  assert.match(field.textContent, /Dark mode/);
});

/* ─────────────────────────────────────────── text field ──────────────────────────────────────── */

test("textInput: label↔input wired by id; hint linked via aria-describedby", () => {
  const field = C.textInput({ label: "Email", hint: "We never share it.", type: "email" });
  const label = findByClass(field, "tm-field-label");
  const input = findByClass(field, "tm-input");
  const hint = findByClass(field, "tm-field-hint");
  assert.ok(label && input && hint);
  assert.equal(input.tagName, "INPUT");
  assert.equal(input.getAttribute("type"), "email");
  assert.equal(label.getAttribute("for"), input.getAttribute("id"), "label points at the input id");
  assert.equal(input.getAttribute("aria-describedby"), hint.getAttribute("id"), "input describes its hint");
});

/* ──────────────────────────────────────────── progress ───────────────────────────────────────── */

test("progress: role=progressbar with aria value range + a width-styled fill", () => {
  const p = C.progress({ value: 25, max: 100 });
  assert.equal(p.getAttribute("role"), "progressbar");
  assert.equal(p.getAttribute("aria-valuenow"), "25");
  assert.equal(p.getAttribute("aria-valuemax"), "100");
  const fill = findByClass(p, "tm-progress-fill");
  assert.match(fill.getAttribute("style") || "", /width:\s*25%/);
});

test("progress: indeterminate drops aria-valuenow and flags the class", () => {
  const p = C.progress({ indeterminate: true });
  assert.ok(p.classList.contains("tm-progress-indeterminate"));
  assert.equal(p.getAttribute("aria-valuenow"), null);
});

/* ─────────────────────────────────────── avatar & reaction ───────────────────────────────────── */

test("initials: 1–2 letters from a name, sane fallbacks (pure)", () => {
  assert.equal(C.initials("Omar Farouk"), "OF");
  assert.equal(C.initials("Layla"), "LA");
  assert.equal(C.initials("  "), "?");
  assert.equal(C.initials(""), "?");
});

test("avatar: initials chip by default; photo (img) when src given; size modifier", () => {
  const initialsAvatar = C.avatar("Omar Farouk");
  assert.ok(initialsAvatar.classList.contains("tm-avatar"));
  assert.equal(initialsAvatar.textContent, "OF");
  assert.equal(initialsAvatar.getAttribute("aria-label"), "Omar Farouk");

  const photo = C.avatar("Omar", { src: "/x.jpg", size: "lg" });
  assert.ok(photo.classList.contains("tm-avatar-lg"));
  const img = findByClass(photo, "tm-avatar") ? photo.children.find((c) => c.tagName === "IMG") : null;
  assert.ok(img, "photo avatar contains an <img>");
  assert.equal(img.getAttribute("src"), "/x.jpg");
});

test("reaction: emoji + count; press toggles aria-pressed", () => {
  let pressed = null;
  const r = C.reaction("👍", { count: 3, onClick: (v) => { pressed = v; } });
  assert.equal(r.getAttribute("aria-pressed"), "false");
  assert.match(r.textContent, /3/);
  r.fire("click");
  assert.equal(r.getAttribute("aria-pressed"), "true");
  assert.equal(pressed, true);
});

/* ─────────────────────────────────────────── badges ──────────────────────────────────────────── */

test("badge: variant → the shared badge classes", () => {
  assert.ok(C.badge("New").classList.contains("tm-badge"));
  assert.ok(C.badge("Going", { variant: "ok" }).classList.contains("tm-badge-ok"));
  assert.ok(C.badge("Admin", { variant: "admin" }).classList.contains("tm-badge-role-admin"));
});

test("countBadge: caps at max with a trailing +", () => {
  assert.equal(C.countBadge(3).textContent, "3");
  assert.equal(C.countBadge(150, { max: 99 }).textContent, "99+");
  assert.ok(C.countBadge(3).classList.contains("tm-badge-count"));
});

/* ─────────────────────────────── read receipts (incl. TM-433 triple-tick) ────────────────────── */

test("readReceiptState: pure descriptor — tick count + read flag per state", () => {
  assert.deepEqual(C.readReceiptState("sent"), { state: "sent", ticks: 1, read: false, label: "Sent" });
  assert.deepEqual(C.readReceiptState("delivered"), { state: "delivered", ticks: 2, read: false, label: "Delivered" });
  assert.deepEqual(C.readReceiptState("read"), { state: "read", ticks: 2, read: true, label: "Read" });
  // TM-433: the whole-group-read state is the TRIPLE tick and reads as "everyone".
  assert.deepEqual(C.readReceiptState("group-read"), { state: "group-read", ticks: 3, read: true, label: "Read by everyone" });
  // unknown falls back to sent (never throws / renders blank)
  assert.equal(C.readReceiptState("bogus").state, "sent");
});

test("readReceipt: renders the right number of ✓ and the read colour class per state", () => {
  const sent = C.readReceipt("sent");
  assert.equal(allByClass(sent, "tm-tick").length, 1);
  assert.ok(!sent.classList.contains("tm-ticks-read"));
  assert.equal(sent.getAttribute("aria-label"), "Sent");

  const delivered = C.readReceipt("delivered");
  assert.equal(allByClass(delivered, "tm-tick").length, 2);
  assert.ok(!delivered.classList.contains("tm-ticks-read"));

  const read = C.readReceipt("read");
  assert.equal(allByClass(read, "tm-tick").length, 2);
  assert.ok(read.classList.contains("tm-ticks-read"), "read state turns accent");

  // The headline TM-511 requirement: triple-tick = whole-group-read, accent, correctly labelled.
  const group = C.readReceipt("group-read");
  assert.equal(allByClass(group, "tm-tick").length, 3, "whole-group-read is the triple tick");
  assert.ok(group.classList.contains("tm-ticks-read"));
  assert.equal(group.getAttribute("aria-label"), "Read by everyone");
  assert.equal(group.dataset.state, "group-read");
});

test("RECEIPT_STATES: the four states in order", () => {
  assert.deepEqual(C.RECEIPT_STATES, ["sent", "delivered", "read", "group-read"]);
});

/* ────────────────────────────────────── bottom sheet / modal ─────────────────────────────────── */

test("bottomSheet: mounts a docked dialog on document.body and closes programmatically", () => {
  const before = document.body.children.length;
  const sheet = C.bottomSheet("Filters", [C.button("Apply")]);
  assert.equal(document.body.children.length, before + 1);
  assert.ok(sheet.el.classList.contains("tm-backdrop-sheet"));
  const dialog = findByClass(sheet.el, "tm-sheet");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-label"), "Filters");
  sheet.close();
  assert.equal(document.body.children.length, before, "close() removes the sheet");
});

test("library re-exports the shared overlay primitives (single import surface)", () => {
  assert.equal(typeof C.modal, "function");
  assert.equal(typeof C.confirmDialog, "function");
});

/* ───────────────────────── token-driven restyle: the CSS is token-only (AC2) ─────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "../src/assets/styles.css"), "utf8");
const START = "==== TM-511 COMPONENT LIBRARY START ====";
const END = "==== TM-511 COMPONENT LIBRARY END ====";

/** The TM-511 component-library block of the stylesheet, with comments stripped so the colour-literal
 *  checks only ever see real declarations (never prose that mentions a #hex or rgb() in passing). */
function componentCss() {
  const a = CSS.indexOf(START);
  const b = CSS.indexOf(END);
  assert.ok(a !== -1 && b !== -1 && b > a, "the TM-511 CSS block must be delimited by its sentinels");
  return CSS.slice(a, b)
    .replace(/^[\s\S]*?\*\//, "")     // drop the header comment's tail (the slice starts inside it)
    .replace(/\/\*[\s\S]*?\*\//g, "") // drop the section comments
    .replace(/\/\*[\s\S]*$/, "");     // drop the dangling END-sentinel comment opener
}

test("component CSS carries NO raw hex or rgb()/hsl() colour — tokens only (AC2)", () => {
  const block = componentCss();
  // No hex colours (#fff, #0f9d8c, …). A theme value must come from a token, so any hex is drift.
  const hex = block.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hex, [], `no hard-coded hex colours allowed; found: ${hex.join(", ")}`);
  // No raw rgb()/rgba()/hsl() literals either (the tokens already re-express those as color-mix).
  assert.equal((block.match(/\b(?:rgba?|hsla?)\(/g) || []).length, 0, "no raw rgb()/hsl() literals");
});

test("component CSS colours/borders/shadows resolve to var(--…) tokens", () => {
  const block = componentCss();
  // Every `color:` / `background:` (bar `transparent` / `none` / `inherit`) reads a token.
  for (const m of block.matchAll(/\b(color|background)\s*:\s*([^;]+);/g)) {
    const value = m[2].trim();
    if (["transparent", "none", "inherit"].includes(value)) continue;
    assert.match(value, /var\(--/, `${m[1]} must use a token, got "${value}"`);
  }
  // The read state + selected states are the theme-reactive bits — assert they hit accent tokens.
  assert.match(block, /\.tm-ticks-read\s*\{[^}]*color:\s*var\(--accent\)/s, "read receipts turn var(--accent)");
  assert.match(block, /\.tm-toggle\[aria-checked="true"\]\s*\{[^}]*background:\s*var\(--accent\)/s, "toggle-on uses var(--accent)");
  // The one sanctioned fixed-chrome primitive: the toggle thumb stays var(--white).
  assert.match(block, /\.tm-toggle-thumb\s*\{[^}]*background:\s*var\(--white\)/s, "toggle thumb is var(--white)");
});
