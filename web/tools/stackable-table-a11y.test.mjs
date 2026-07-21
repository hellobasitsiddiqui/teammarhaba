// TM-935 a11y guard — `stackableTable()` re-adds the ARIA semantics the ≤30rem stacked-card CSS strips.
//
// WHY. The admin consoles all render a real `<table class="tm-table">`, and the phone media block flips
// every table element to `display: block` to paint each row as a labelled card. That block-display is
// what STRIPS the implicit table/row/cell/columnheader roles AND the <th scope="col"> → cell header
// association, leaving only the CSS `::before { content: attr(data-label) }` label — which many screen-
// reader verbosity settings skip. `stackableTable()` (ui.js) hardens the pattern: it stamps explicit
// roles back onto the whole subtree so it stays a grid when block-displayed, and drops a visually-hidden
// real label span into each labelled <td> so the field name lives in the accessibility tree, not just in
// generated content. This test pins both behaviours so a later edit can't silently drop the ARIA layer.
//
// Framework-free, no jsdom (CI pins Node 20): we drive the helper against a minimal fake `document` that
// implements just enough (createElement + querySelectorAll for the tag/[data-label] selectors + prepend)
// for stackableTable to run, mirroring the ui-el-xss-safe.test.mjs fake-DOM approach.

import assert from "node:assert/strict";
import { test } from "node:test";

// --- A minimal fake DOM: enough of Element for stackableTable() to run ------------------------------
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
    get textContent() {
      return this._textContent;
    },
    set textContent(v) {
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
    prepend(...nodes) {
      this.children.unshift(...nodes);
    },
    // Depth-first walk collecting every element descendant (not self).
    _descendants() {
      const out = [];
      for (const c of this.children) {
        if (c && c.nodeType === 1) {
          out.push(c);
          out.push(...c._descendants());
        }
      }
      return out;
    },
    // Supports the two selector shapes stackableTable uses: a tag list ("thead, tbody, tr, th, td")
    // and the labelled-cell selector ("td[data-label]").
    querySelectorAll(selector) {
      const all = this._descendants();
      if (selector.includes("[data-label]")) {
        return all.filter((n) => n.tagName === "TD" && "data-label" in n.attrs);
      }
      const tags = selector.split(",").map((s) => s.trim().toUpperCase());
      return all.filter((n) => tags.includes(n.tagName));
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

const { el, stackableTable } = await import("../src/assets/ui.js");

// Build a small but representative thead+tbody the way the consoles do.
function buildParts() {
  const head = el("thead", {}, [
    el("tr", {}, [
      el("th", { scope: "col", text: "Status" }),
      el("th", { scope: "col", text: "Actions" }),
    ]),
  ]);
  const body = el("tbody", {}, [
    el("tr", {}, [
      el("td", { "data-label": "Status" }, [el("span", { text: "Deactivated" })]),
      el("td", { class: "tm-actions" }, [el("button", { text: "Edit" })]),
    ]),
  ]);
  return { head, body };
}

test("stackableTable stamps the implicit table roles the block-display CSS strips", () => {
  withFakeDocument(() => {
    const { head, body } = buildParts();
    const table = stackableTable(head, body);

    assert.equal(table.getAttribute("role"), "table", "the <table> itself must carry role=table");
    assert.equal(head.getAttribute("role"), "rowgroup", "<thead> → role=rowgroup");
    assert.equal(body.getAttribute("role"), "rowgroup", "<tbody> → role=rowgroup");

    const rows = table.querySelectorAll("tr");
    assert.ok(rows.length >= 2 && rows.every((r) => r.getAttribute("role") === "row"), "every <tr> → role=row");

    const headers = table.querySelectorAll("th");
    assert.ok(headers.length >= 2 && headers.every((h) => h.getAttribute("role") === "columnheader"), "every <th> → role=columnheader");

    const cells = table.querySelectorAll("td");
    assert.ok(cells.length >= 2 && cells.every((c) => c.getAttribute("role") === "cell"), "every <td> → role=cell");
  });
});

test("stackableTable puts each field label in the a11y tree via a .tm-cell-label span (not only ::before)", () => {
  withFakeDocument(() => {
    const { head, body } = buildParts();
    const table = stackableTable(head, body);

    const statusCell = table
      .querySelectorAll("td[data-label]")
      .find((c) => c.getAttribute("data-label") === "Status");
    assert.ok(statusCell, "the Status cell should be a labelled td");

    // The label span is PREPENDED (reads before the value) and carries the field name as real text.
    const first = statusCell.children[0];
    assert.equal(first.tagName, "SPAN", "the injected label is the first child (prepended)");
    assert.equal(first.className, "tm-cell-label", "it uses the .tm-cell-label hook the CSS toggles per breakpoint");
    assert.equal(first.textContent, "Status: ", "it carries the column name so a badge reads 'Status: Deactivated'");
  });
});

test("stackableTable leaves the unlabelled control cell (Actions) without a label span", () => {
  withFakeDocument(() => {
    const { head, body } = buildParts();
    const table = stackableTable(head, body);
    const actionsCell = table.querySelectorAll("td").find((c) => c.className === "tm-actions");
    assert.ok(actionsCell, "the actions cell exists");
    assert.ok(
      !actionsCell.children.some((n) => n.nodeType === 1 && n.className === "tm-cell-label"),
      "a control cell with no data-label gets no injected label span",
    );
  });
});
