// Notification-panel dialog focusability guard (TM-559). Framework-free — Node's built-in test
// runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// `notification-panel.js open()` builds the dropdown card with `role="dialog"` + `aria-modal="true"`
// and calls `panel.focus?.()` to seat focus inside the dialog. But a bare <div> is not focusable, so
// without a `tabindex` the `.focus()` call is a silent no-op: focus stays on the bell, there's no
// focus trap, and the `.tm-np-panel:focus` CSS is dead (an aria-modal dialog opening with focus left
// outside it — an a11y/keyboard degradation). The fix adds `tabindex: -1`, which makes the dialog
// programmatically focusable (but keeps it out of the Tab order).
//
// The full module can't be imported in Node (a transitive `https:` Firebase import in the auth/storage
// chain isn't resolvable by the default ESM loader), so — like deploy-theme-retired.test.mjs — this is
// a source-level guard: it isolates the dialog's `el()` props and asserts the focus contract holds, so
// a later edit can't silently drop `tabindex` (or the `.focus()` call) and re-break keyboard/a11y.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../src/assets/notification-panel.js"), "utf8");

/** The props object literal of the `const panel = el("div", { ... }, ...)` call (up to the first `}`). */
function dialogProps() {
  const m = SRC.match(/const panel = el\(\s*"div",\s*\{([\s\S]*?)\n\s*\},/);
  assert.ok(m, "could not locate the `const panel = el(\"div\", { ... })` dialog builder");
  return m[1];
}

test("the panel el() is the aria-modal dialog (role + aria-modal intact)", () => {
  const props = dialogProps();
  assert.match(props, /role:\s*"dialog"/, 'panel must keep role: "dialog"');
  assert.match(props, /"aria-modal":\s*"true"/, 'panel must keep aria-modal: "true"');
});

test("the dialog is programmatically focusable — tabindex: -1 on its el() props (TM-559)", () => {
  const props = dialogProps();
  assert.match(
    props,
    /\btabindex:\s*-1\b/,
    "the role=dialog panel must set tabindex: -1 so panel.focus() can seat focus inside the dialog",
  );
});

test("open() still calls panel.focus() — the call tabindex: -1 makes effective", () => {
  // The focus seat is the whole point of the tabindex; guard that the .focus() call isn't removed.
  assert.match(SRC, /panel\.focus\?\.\(\)/, "open() must still call panel.focus?.() to seat focus in the dialog");
});
