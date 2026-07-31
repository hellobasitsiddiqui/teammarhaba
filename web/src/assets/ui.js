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

// TM-1186 — the ONE reusable collapsible-section abstraction the admin event form (and the retired
// "More options" fold, TM-1066) is regrouped onto (TM-1187 consumes it; TM-1188 supplies real summaries).
//
// WHY a native <details>/<summary>. It gives keyboard toggle + `aria-expanded` for FREE, and — the
// headline requirement — folds are INDEPENDENT: a native <details> has no shared open-state, so several
// sections can be open at once and there is no accordion/close-on-open logic to build (or to accidentally
// introduce). It reuses the TM-398 `.tm-event-calendar` disclosure look via `.tm-form-section` so the
// toggle reads consistently with the rest of the events UI (styles.css, appended block).
//
// The `summary` slot is the collapsed-header VALUE line (e.g. "Sat 2 Aug, 7pm") that renders next to the
// title so a folded section still shows what it holds. TM-1188 supplies real ones; the slot is honoured
// now and updatable later via the returned `setSummary()`.
//
// Returns a minimal, documented handle so the regroup (TM-1187/1189) can drive a section from outside:
//   • `el`          — the <details> root (append it into the form layout)
//   • `setOpen(bool)` — force the fold open/closed (used to reveal a section whose field is in error)
//   • `setSummary(str)` — update the one-line collapsed value (used as fields change)
//
/**
 * Build a collapsible form section over a native <details>/<summary>.
 * @param {{title: string, open?: boolean, summary?: (() => string)|null,
 *   children?: (Node|string|null)[]|Node|string}} cfg
 *   `title` = the section heading; `open` = initial open state (default false); `summary` = optional fn
 *   returning the one-line collapsed value; `children` = the section body nodes.
 * @returns {{el: HTMLDetailsElement, setOpen: (open: boolean) => void, setSummary: (value: string) => void}}
 */
export function buildFormSection({ title, open = false, summary = null, children = [] } = {}) {
  // The title + (optional) value share the <summary>; separate spans so the value can be re-rendered
  // independently and the title text is never clobbered when the summary updates.
  const titleNode = el("span", { class: "tm-form-section-title", text: title });
  const valueNode = el("span", { class: "tm-form-section-value" });
  const setSummary = (value) => {
    // textContent (via el's text path) is the safe sink — the value is always inert text, never markup.
    valueNode.textContent = value == null ? "" : String(value);
  };
  if (typeof summary === "function") setSummary(summary());

  const summaryNode = el("summary", { class: "tm-form-section-toggle" }, [titleNode, valueNode]);
  const body = el("div", { class: "tm-form-section-body" }, children);
  const details = el("details", { class: "tm-form-section" }, [summaryNode, body]);
  // Set the `open` PROPERTY (not the boolean attribute) so it's identical whether a caller later reads
  // `.open` or the attribute — the native <details> reflects the property to the attribute for us.
  details.open = !!open;

  return {
    el: details,
    // Set the `open` property (reflects to the attribute) so callers get the same result whether they
    // read the property or the attribute — mirrors how the More-options fold force-opens on error.
    setOpen: (isOpen) => {
      details.open = !!isOpen;
    },
    setSummary,
  };
}

// The toast host id. Held in a constant because it is referenced in two places that MUST agree: the
// lazy host builder below, and the modal-layer inert sweep (TM-947), which permanently exempts this
// node so toasts sit ON the modal layer rather than being inerted behind it (item 1b).
const TOAST_HOST_ID = "tm-toasts";

function toastHost() {
  let host = document.getElementById(TOAST_HOST_ID);
  if (!host) {
    host = el("div", { id: TOAST_HOST_ID, class: "tm-toasts", role: "status", "aria-live": "polite" });
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

// ── Shared modal layer (TM-947) ─────────────────────────────────────────────────────────────────
//
// confirmDialog() and modal() are both aria-modal dialogs and must behave identically: background
// inerted, Tab trapped inside, focus restored to the opener on close. Before TM-947 only confirmDialog
// had any of that; modal() had none (the parity gap). Rather than copy the logic, both now go through
// ONE helper — openModalLayer — so the contract lives in a single place (the AC mandates shared, not
// copied).
//
// The helper also fixes three sharp edges the original single-shot sweep had:
//   • Item 1a — a toast fired WHILE a dialog is open was never inerted (the sweep ran once at open, so
//     a later sibling stayed tabbable behind the backdrop). A MutationObserver now inerts siblings as
//     they mount.
//   • Item 1b — a pre-existing #tm-toasts host GOT inerted, so persistent toasts went click-dead under
//     the dialog. The sweep + observer now permanently exempt the toast host, so toasts join the modal
//     layer (they render above the backdrop and stay interactive).
//   • Item 2 — stacking. Only the TOPMOST layer is active: Escape and the Tab trap act on the frontmost
//     dialog only, so two stacked dialogs don't double-close or fight over focus.

// The stack of currently-open modal layers, oldest → newest. The last entry is the topmost (active) one.
const modalLayerStack = [];

/** Focusable descendants of a dialog, in DOM order — the Tab ring the trap cycles through. */
function focusableWithin(dialog) {
  const sel = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
    "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
  return dialog.querySelectorAll ? Array.from(dialog.querySelectorAll(sel)) : [];
}

/**
 * Open a modal layer: append the backdrop, inert the background (now + as it grows), trap Tab inside
 * the dialog, and make Escape close it — but only while this layer is the topmost one.
 *
 * @param {{backdrop: HTMLElement, dialog: HTMLElement, onEscape: Function, initialFocus?: HTMLElement}} cfg
 * @returns {() => void} teardown — un-inert the background, stop observing, restore focus to the opener,
 *   and pop this layer off the stack. Idempotent.
 */
function openModalLayer({ backdrop, dialog, onEscape, initialFocus }) {
  // Remember who had focus so we can hand it back on close (unless a destructive action removed it).
  const opener = document.activeElement;
  // Only the nodes WE inerted, so a node that was ALREADY inert/aria-hidden isn't un-hidden on close.
  const inerted = [];

  // Inert one background sibling (untabbable + click-dead + hidden from AT), tracking it for restore.
  // Never touches the toast host (item 1b) or a node we already inerted / that was pre-inert.
  const inertSibling = (node) => {
    if (node === backdrop) return;
    if (node.id === TOAST_HOST_ID) return; // toasts sit ON the modal layer, never behind it
    if (node.inert || (node.getAttribute && node.getAttribute("aria-hidden") === "true")) return;
    node.inert = true;
    if (node.setAttribute) node.setAttribute("aria-hidden", "true");
    inerted.push(node);
  };

  const isTopmost = () => modalLayerStack[modalLayerStack.length - 1] === layer;

  const onKey = (e) => {
    if (!isTopmost()) return; // item 2: only the frontmost dialog reacts to keys
    if (e.key === "Escape") {
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    // Focus trap: cycle within the dialog's focusable ring; pull focus back in if it left the dialog.
    const ring = focusableWithin(dialog);
    if (ring.length === 0) {
      e.preventDefault();
      if (typeof dialog.focus === "function") dialog.focus();
      return;
    }
    const active = document.activeElement;
    const inside = dialog.contains(active);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Watch for siblings mounted AFTER open (e.g. a toast fired mid-dialog) and inert them too (item 1a).
  // Guarded so a non-DOM/legacy environment without MutationObserver just skips the live sweep.
  let observer = null;
  if (typeof MutationObserver !== "undefined") {
    observer = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes || []) {
          if (node.nodeType === 1) inertSibling(node);
        }
      }
    });
    observer.observe(document.body, { childList: true });
  }

  const layer = { onKey };

  let torn = false;
  const teardown = () => {
    if (torn) return; // idempotent: Escape + button + backdrop-click can all race onto close
    torn = true;
    if (observer) observer.disconnect();
    for (const node of inerted) {
      node.inert = false;
      if (node.removeAttribute) node.removeAttribute("aria-hidden");
    }
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    const i = modalLayerStack.indexOf(layer);
    if (i !== -1) modalLayerStack.splice(i, 1);
    // Hand focus back to the opener (if it's still in the document — a confirmed destructive action
    // may have removed it, e.g. sign-out tearing down the Profile hub).
    if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
  };

  document.body.append(backdrop);
  // Make aria-modal true in fact, not just in name: everything behind the backdrop is inert
  // (unfocusable + untabbable + click-dead) and aria-hidden for screen readers. A dialog stacked over
  // another naturally inerts the lower backdrop here too, so topmost-wins for clicks as well as keys.
  for (const node of Array.from(document.body.children)) inertSibling(node);
  modalLayerStack.push(layer);
  document.addEventListener("keydown", onKey);
  if (initialFocus && typeof initialFocus.focus === "function") initialFocus.focus();

  return teardown;
}

/**
 * A styled, accessible confirm dialog (never the native `confirm()`). Resolves `true` on confirm,
 * `false` on cancel / Escape / backdrop click.
 *
 * Honours the `aria-modal="true"` contract for real (TM-906 review), via the shared modal layer
 * (TM-947): while the dialog is open the rest of the page is `inert` + `aria-hidden` (background
 * controls can't be tabbed to, clicked via keyboard, or reached by a screen reader), Tab/Shift+Tab
 * cycle WITHIN the dialog, and on close focus returns to the element that opened it. Without this, a
 * keyboard user could Tab out from under the backdrop and activate background controls while the
 * (destructive) confirm was up.
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
    const close = (result) => {
      teardown();
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
    const teardown = openModalLayer({
      backdrop,
      dialog,
      onEscape: () => close(false),
      initialFocus: confirmBtn,
    });
  });
}

/**
 * A general modal holding arbitrary content. Returns `{ close }`.
 *
 * Has the same aria-modal semantics as confirmDialog — background inert, Tab trapped inside, focus
 * restored to the opener on close — because both share `openModalLayer` (TM-947, closing the parity
 * gap where modal() previously had none of these).
 */
export function modal(title, content, { onClose = null } = {}) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    teardown();
    // Fire once, AFTER teardown, for ANY close path (button, Esc, backdrop) so callers can resolve a
    // "dismissed" outcome without polling the DOM (TM-1061 clone offset picker).
    if (typeof onClose === "function") onClose();
  };
  const closeBtn = el(
    "button",
    { class: "tm-toast-close", type: "button", "aria-label": "Close", onClick: close },
    "×",
  );
  const dialog = el("div", { class: "tm-dialog tm-modal", role: "dialog", "aria-modal": "true", "aria-label": title }, [
    el("div", { class: "tm-modal-head" }, [
      el("h2", { class: "tm-dialog-title", text: title }),
      closeBtn,
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
  const teardown = openModalLayer({
    backdrop,
    dialog,
    onEscape: () => close(),
    // Seat focus inside the dialog on open (the close button is always present). This is what gives
    // modal() a working trap: focusableWithin() then keeps Tab inside.
    initialFocus: closeBtn,
  });
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

// --- Timezone <select> helpers (TM-1067) ------------------------------------------------------------
//
// Lifted here from admin-events.js so BOTH admin consoles (events + venues) populate a timezone picker
// through ONE copy — the events form inherits its default from a venue's timezone, so the two must stay
// identical. Self-contained by design: it uses only Intl + ui.js's own el()/clear(), so it doesn't drag
// ui.js onto the event-form.js/Firebase import chain.

// Fallback timezone shortlist if Intl.supportedValuesOf isn't available (older engines). The real list
// is the full IANA set; this just keeps the picker usable everywhere.
const FALLBACK_TIME_ZONES = [
  "UTC", "Europe/London", "Europe/Paris", "Europe/Istanbul", "America/New_York", "America/Los_Angeles",
  "America/Sao_Paulo", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo",
  "Australia/Sydney",
];

/** The browser/runtime's best-guess IANA zone (for a new record's default), or "" if unknowable. */
export function guessTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/** Make sure `zone` is a selectable option in a timezone <select> (defensive for a non-listed id). */
export function ensureZoneOption(select, zone) {
  if (!zone) return;
  if (![...select.options].some((o) => o.value === zone)) {
    select.append(el("option", { value: zone, text: zone }));
  }
}

/** Populate a timezone <select> with the full IANA set (or the fallback), preselecting `selected`. */
export function fillTimeZoneOptions(select, selected) {
  let zones;
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = null;
  }
  if (!Array.isArray(zones) || !zones.length) zones = FALLBACK_TIME_ZONES.slice();
  const chosen = (selected || guessTimeZone() || "UTC").trim();
  if (chosen && !zones.includes(chosen)) zones = [chosen, ...zones];
  clear(select).append(...zones.map((z) => el("option", { value: z, text: z, selected: z === chosen })));
  select.value = chosen;
}
