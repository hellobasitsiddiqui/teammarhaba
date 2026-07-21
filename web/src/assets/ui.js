// Reusable, framework-free UX primitives — TM-133.
//
// Built here because the admin users console is the first surface that needs them, kept generic
// so future pages reuse them: a tiny XSS-safe DOM builder, toasts (with optional undo action),
// a styled confirm dialog (never the native `confirm()`), copy-to-clipboard, and relative time.
//
// XSS-safety is structural: `el()` only ever sets text via `textContent`, so untrusted strings
// (emails, names) can never inject markup. There is intentionally no innerHTML seam.

/**
 * Build a DOM element.
 * @param {string} tag
 * @param {Object} [props] attributes + specials: `class`, `text` (safe textContent),
 *   `dataset` (object), `on<Event>` (listener fn). Boolean values set/omit bare attributes.
 * @param {(Node|string|null)[]|Node|string} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Remove all children of a node (safer + clearer than innerHTML = ""). */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// TM-935: the admin consoles all build the same `<table class="tm-table">` (a <thead> row + a <tbody>)
// and the ≤30rem media block flips every table element to `display: block` to paint each row as a
// labelled card. That block-display is what STRIPS the implicit ARIA table semantics: once a <td>/<tr>/
// <table> is display:block the browser no longer exposes it as a cell/row/table, so a screen-reader user
// loses table navigation AND the <th scope="col"> → cell header association — the only field label left
// is the CSS `::before { content: attr(data-label) }`, which many SR verbosity settings skip. This helper
// hardens the pattern: it stamps back explicit roles (so the grid stays a grid when block-displayed) and
// drops a visually-hidden real label span into each labelled <td>, so the field name lives in the
// accessibility tree instead of only in generated content. Desktop is unchanged: the roles mirror the
// native semantics, and `.tm-cell-label` is `display:none` above 30rem (so it's out of the a11y tree too,
// no redundant "Status:" over the intact <thead> association).
const ROLE_BY_TAG = { TABLE: "table", THEAD: "rowgroup", TBODY: "rowgroup", TR: "row", TH: "columnheader", TD: "cell" };

/**
 * Build a `<table class="tm-table">` from a <thead>-row and a <tbody>, ARIA-hardened for the ≤30rem
 * stacked-card layout. Pass the same nodes the consoles already build.
 * @param {HTMLElement} head a <thead> element (or its row) — role="rowgroup"/"row"/"columnheader" get stamped
 * @param {HTMLElement} body a <tbody> element — rows/cells get role + a visually-hidden data-label span
 * @returns {HTMLTableElement}
 */
export function stackableTable(head, body) {
  const table = el("table", { class: "tm-table" }, [head, body]);
  // Walk the subtree once and stamp the role the tag's implicit semantics would otherwise provide.
  for (const node of [table, ...table.querySelectorAll("thead, tbody, tr, th, td")]) {
    const role = ROLE_BY_TAG[node.tagName];
    if (role) node.setAttribute("role", role);
  }
  // Put each field name in the a11y tree (not just CSS ::before). Prepended so it reads before the value.
  for (const cell of table.querySelectorAll("td[data-label]")) {
    cell.prepend(el("span", { class: "tm-cell-label", text: `${cell.getAttribute("data-label")}: ` }));
  }
  return table;
}

function toastHost() {
  let host = document.getElementById("tm-toasts");
  if (!host) {
    host = el("div", { id: "tm-toasts", class: "tm-toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  return host;
}

/**
 * Show a toast. Returns a `dismiss()` function.
 *
 * `timeout: 0` makes the card PERSISTENT — it stays until the user hits × / the action, or the
 * caller invokes the returned dismiss. That's the seam the foreground-push card (TM-374) uses so a
 * notification can't silently vanish. `onDismiss` (fires exactly once, however the card goes away)
 * lets such callers react — e.g. mark the underlying notification as seen.
 * @param {string} message
 * @param {{type?: "success"|"error"|"info", action?: {label: string, onClick: Function},
 *   timeout?: number, onDismiss?: Function}} [opts]
 */
export function toast(message, { type = "info", action = null, timeout = 5000, onDismiss = null } = {}) {
  const host = toastHost();
  const card = el("div", { class: `tm-toast tm-toast-${type}` }, [el("span", { text: message })]);
  let timer;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return; // idempotent: action-click + caller + timeout can all race onto this.
    dismissed = true;
    clearTimeout(timer);
    card.remove();
    if (typeof onDismiss === "function") onDismiss();
  };
  if (action && typeof action.onClick === "function") {
    card.append(el(
      "button",
      {
        class: "tm-toast-action",
        type: "button",
        onClick: () => {
          dismiss();
          action.onClick();
        },
      },
      action.label || "Undo",
    ));
  }
  card.append(el(
    "button",
    { class: "tm-toast-close", type: "button", "aria-label": "Dismiss", onClick: dismiss },
    "×",
  ));
  host.append(card);
  if (timeout) timer = setTimeout(dismiss, timeout);
  return dismiss;
}

/**
 * A styled, accessible confirm dialog (never the native `confirm()`). Resolves `true` on confirm,
 * `false` on cancel / Escape / backdrop click.
 *
 * Honours the `aria-modal="true"` contract for real (TM-906 review): while the dialog is open the
 * rest of the page is `inert` + `aria-hidden` (background controls can't be tabbed to, clicked via
 * keyboard, or reached by a screen reader), Tab/Shift+Tab cycle WITHIN the dialog, and on close
 * focus returns to the element that opened it. Without this, a keyboard user could Tab out from
 * under the backdrop and activate background controls while the (destructive) confirm was up.
 *
 * The two buttons carry stable DOM ids (#tm-dialog-confirm / #tm-dialog-cancel) — the automation
 * hooks the Maestro mobile flows use, since both the trigger row and the confirm button can share
 * visible text (e.g. "Sign out") and Maestro matches text as an anchored regex.
 * @param {{title?: string, message?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = "Are you sure?",
  message = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    // Background siblings we inerted (only ones WE set, so a pre-hidden node isn't un-hidden on close).
    const inerted = [];
    const onKey = (e) => {
      if (e.key === "Escape") {
        close(false);
        return;
      }
      if (e.key !== "Tab") return;
      // Focus trap: the dialog's tab ring is exactly [cancelBtn, confirmBtn] (DOM order). Wrap at
      // the ends, and pull focus back in if it somehow left the dialog (e.g. was on <body>).
      const ring = [cancelBtn, confirmBtn];
      const active = document.activeElement;
      const inside = dialog.contains(active);
      if (e.shiftKey) {
        if (!inside || active === ring[0]) {
          e.preventDefault();
          ring[ring.length - 1].focus();
        }
      } else if (!inside || active === ring[ring.length - 1]) {
        e.preventDefault();
        ring[0].focus();
      }
    };
    const close = (result) => {
      for (const node of inerted) {
        node.inert = false;
        node.removeAttribute("aria-hidden");
      }
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      // Hand focus back to the opener (if it's still in the document — a confirmed destructive
      // action may have removed it, e.g. sign-out tearing down the Profile hub).
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
      resolve(result);
    };
    const cancelBtn = el(
      "button",
      { class: "tm-btn", id: "tm-dialog-cancel", type: "button", onClick: () => close(false) },
      cancelLabel,
    );
    const confirmBtn = el(
      "button",
      {
        class: `tm-btn ${danger ? "tm-btn-danger" : "tm-btn-primary"}`,
        id: "tm-dialog-confirm",
        type: "button",
        onClick: () => close(true),
      },
      confirmLabel,
    );
    const dialog = el("div", { class: "tm-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("h2", { class: "tm-dialog-title", text: title }),
      message ? el("p", { class: "tm-dialog-msg", text: message }) : null,
      el("div", { class: "tm-dialog-actions" }, [cancelBtn, confirmBtn]),
    ]);
    const backdrop = el(
      "div",
      {
        class: "tm-backdrop",
        onClick: (e) => {
          if (e.target === backdrop) close(false);
        },
      },
      [dialog],
    );
    document.body.append(backdrop);
    // Make aria-modal true in fact, not just in name: everything behind the backdrop is inert
    // (unfocusable + untabbable + click-dead) and aria-hidden for screen readers.
    for (const node of document.body.children) {
      if (node === backdrop) continue;
      if (node.inert || node.getAttribute("aria-hidden") === "true") continue;
      node.inert = true;
      node.setAttribute("aria-hidden", "true");
      inerted.push(node);
    }
    document.addEventListener("keydown", onKey);
    confirmBtn.focus();
  });
}

/** A general modal holding arbitrary content. Returns `{ close }`. */
export function modal(title, content) {
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const dialog = el("div", { class: "tm-dialog tm-modal", role: "dialog", "aria-modal": "true", "aria-label": title }, [
    el("div", { class: "tm-modal-head" }, [
      el("h2", { class: "tm-dialog-title", text: title }),
      el("button", { class: "tm-toast-close", type: "button", "aria-label": "Close", onClick: close }, "×"),
    ]),
    el("div", { class: "tm-modal-body" }, content),
  ]);
  const backdrop = el(
    "div",
    {
      class: "tm-backdrop",
      onClick: (e) => {
        if (e.target === backdrop) close();
      },
    },
    [dialog],
  );
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  return { close };
}

/** Copy `text` to the clipboard; toasts the result by default. Returns success boolean. */
export async function copyToClipboard(text, { notify = true } = {}) {
  try {
    await navigator.clipboard.writeText(text);
    if (notify) toast("Copied to clipboard.", { type: "success", timeout: 2000 });
    return true;
  } catch {
    if (notify) toast("Couldn't copy.", { type: "error" });
    return false;
  }
}

/**
 * A relative-time string for a Date/ISO value, plus an absolute string for a tooltip.
 * @returns {{text: string, title: string}}
 */
export function relativeTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { text: "—", title: "" };
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const title = date.toLocaleString();
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, size] of units) {
    const n = Math.floor(Math.abs(seconds) / size);
    if (n >= 1) return { text: `${n} ${name}${n > 1 ? "s" : ""} ${seconds < 0 ? "from now" : "ago"}`, title };
  }
  return { text: "just now", title };
}
