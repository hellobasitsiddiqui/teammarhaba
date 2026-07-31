// TM-1186 — `buildFormSection()`, the ONE reusable collapsible-section abstraction the admin event
// form (and the retired "More options" fold) will be regrouped onto (TM-1187 consumes it). This is the
// component's unit contract: a native <details>/<summary> disclosure with a title, an initial-open flag,
// an optional one-line value summary rendered next to the title, section-body children, and a minimal
// handle (`el`, `setOpen`, `setSummary`) so the regroup can force a section open on error and update its
// collapsed summary.
//
// WHY native <details>. It gives keyboard toggle + aria-expanded for free, and — the ticket's headline
// requirement — folds are INDEPENDENT (several open at once), which a native <details> is by default:
// there is no shared accordion/close-on-open state to build or to accidentally introduce.
//
// Framework-free, no jsdom (CI pins Node 20, only stable node: built-ins): we drive the builder against
// the same minimal hand-rolled fake `document` the ui-el-xss-safe / stackable-table tests use, so this
// runs in plain Node under the CI glob `node --test web/tools/*.test.mjs`. A companion source guard pins
// that the disclosure stays a native <details> (no div+JS reimplementation that would lose the a11y).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- A minimal fake DOM: enough of Element for el()/buildFormSection() to run ------------------------
function fakeTextNode(str) {
  return { nodeType: 3, data: String(str), tagName: undefined };
}

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
    open: false, // <details> reflects its `open` property; el() sets it via the boolean-attr path too
    get textContent() {
      return this._textContent;
    },
    set textContent(v) {
      this._textContent = String(v);
      // Real textContent replaces children; the summary-update path relies on that.
      this.children = [];
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    hasAttribute(k) {
      return k in this.attrs;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    append(...nodes) {
      for (const n of nodes) this.children.push(n);
    },
    // Enough querySelector for a handle that looks up its summary/body by class.
    querySelector(sel) {
      const cls = sel.replace(/^\./, "");
      const walk = (node) => {
        for (const c of node.children || []) {
          if (c.nodeType === 1) {
            if ((c.className || "").split(/\s+/).includes(cls)) return c;
            const found = walk(c);
            if (found) return found;
          }
        }
        return null;
      };
      return walk(this);
    },
  };
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

// buildFormSection reads `document` at call time via el(); import fresh so the fake is in place.
const { buildFormSection } = await import("../src/assets/ui.js");

// Helpers to read the built structure out of the fake tree.
const findByTag = (node, tag) => {
  for (const c of node.children) {
    if (c.nodeType === 1 && c.tagName === tag) return c;
    if (c.nodeType === 1) {
      const found = findByTag(c, tag);
      if (found) return found;
    }
  }
  return null;
};
const textOf = (node) => {
  if (!node) return "";
  if (node.nodeType === 3) return node.data;
  return (node._textContent || "") + node.children.map(textOf).join("");
};

// --- Structure: native <details>/<summary> with the title -------------------------------------------

test("buildFormSection renders a native <details> whose <summary> carries the title", () => {
  withFakeDocument(() => {
    const { el } = buildFormSection({ title: "Date & time", children: [] });
    assert.equal(el.tagName, "DETAILS", "the section root is a native <details> (free a11y toggle)");
    const summary = findByTag(el, "SUMMARY");
    assert.ok(summary, "a <summary> is present");
    assert.match(textOf(summary), /Date & time/, "the title text lives in the summary");
  });
});

// --- open flag --------------------------------------------------------------------------------------

test("buildFormSection honours the `open` flag (default collapsed)", () => {
  withFakeDocument(() => {
    const collapsed = buildFormSection({ title: "A", children: [] });
    assert.ok(!collapsed.el.open, "omitted/false open → collapsed");

    const opened = buildFormSection({ title: "B", open: true, children: [] });
    assert.equal(opened.el.open, true, "open:true → the <details> is initially open");
  });
});

// --- summary slot -----------------------------------------------------------------------------------

test("the optional summary slot renders its one-line value next to the title when provided", () => {
  withFakeDocument(() => {
    const { el } = buildFormSection({
      title: "Date & time",
      summary: () => "Sat 2 Aug, 7pm",
      children: [],
    });
    const summary = findByTag(el, "SUMMARY");
    const txt = textOf(summary);
    assert.match(txt, /Date & time/, "the title still shows");
    assert.match(txt, /Sat 2 Aug, 7pm/, "the summary value renders in the collapsed header");
  });
});

test("no summary slot renders no value text (only the title)", () => {
  withFakeDocument(() => {
    const { el } = buildFormSection({ title: "Only title", children: [] });
    const summary = findByTag(el, "SUMMARY");
    assert.equal(textOf(summary).trim(), "Only title", "just the title, no stray summary node");
  });
});

// --- children in the body ---------------------------------------------------------------------------

test("children render inside the section body (not in the summary)", () => {
  withFakeDocument(() => {
    const field = document.createElement("input");
    field.setAttribute("id", "event-title");
    const { el } = buildFormSection({ title: "Basics", open: true, children: [field] });
    // The field is somewhere under the <details> but NOT inside the <summary>.
    const summary = findByTag(el, "SUMMARY");
    const inSummary = (node) => node.children.some((c) => c === field || (c.nodeType === 1 && inSummary(c)));
    assert.ok(!inSummary(summary), "the field is not in the summary");
    const anywhere = (node) => node.children.some((c) => c === field || (c.nodeType === 1 && anywhere(c)));
    assert.ok(anywhere(el), "the field is rendered in the section body");
  });
});

// --- exposed handle: setOpen / setSummary -----------------------------------------------------------

test("the handle exposes setOpen() so a caller (TM-1187) can force a section open on error", () => {
  withFakeDocument(() => {
    const handle = buildFormSection({ title: "Advanced", children: [] });
    assert.equal(typeof handle.setOpen, "function", "setOpen is part of the handle");
    handle.setOpen(true);
    assert.equal(handle.el.open, true, "setOpen(true) opens the disclosure");
    handle.setOpen(false);
    assert.equal(handle.el.open, false, "setOpen(false) closes it");
  });
});

test("the handle exposes setSummary() so TM-1187/1188 can update the collapsed value later", () => {
  withFakeDocument(() => {
    const handle = buildFormSection({ title: "Date & time", summary: () => "TBD", children: [] });
    assert.equal(typeof handle.setSummary, "function", "setSummary is part of the handle");
    handle.setSummary("Sat 2 Aug, 7pm");
    const summary = findByTag(handle.el, "SUMMARY");
    assert.match(textOf(summary), /Sat 2 Aug, 7pm/, "the new value shows");
    assert.match(textOf(summary), /Date & time/, "the title is preserved when the summary updates");
    // Clearing the summary removes the value but keeps the title.
    handle.setSummary("");
    const cleared = findByTag(handle.el, "SUMMARY");
    assert.equal(textOf(cleared).trim(), "Date & time", "an empty summary leaves only the title");
  });
});

// --- independent folds (NOT an accordion) -----------------------------------------------------------

test("folds are INDEPENDENT — opening one does not touch another (no accordion coupling)", () => {
  withFakeDocument(() => {
    const a = buildFormSection({ title: "A", children: [] });
    const b = buildFormSection({ title: "B", children: [] });
    a.setOpen(true);
    b.setOpen(true);
    assert.equal(a.el.open, true, "A stays open");
    assert.equal(b.el.open, true, "B is also open — several can be open at once");
  });
});

// --- source guard: the disclosure stays a NATIVE <details> ------------------------------------------

test("buildFormSection is built on a native <details> element (no div-reimplementation)", () => {
  const src = readFileSync(join(HERE, "../src/assets/ui.js"), "utf8");
  assert.match(
    src,
    /function\s+buildFormSection\b/,
    "buildFormSection must be exported from the shared ui.js primitives",
  );
  // The section must be a native <details>/<summary> so keyboard toggle + aria-expanded are free and
  // folds are independent by default — not a div + click handler that reintroduces accordion risk.
  const body = src.slice(src.indexOf("function buildFormSection"));
  assert.match(body, /el\(\s*["']details["']/, "the root must be a native <details>");
  assert.match(body, /el\(\s*["']summary["']/, "the header must be a native <summary>");
});
