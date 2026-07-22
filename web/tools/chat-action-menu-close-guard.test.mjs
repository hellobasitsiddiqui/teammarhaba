// Source guards for the TM-957 message-action-menu closure fixes (from the TM-942 closure review of TM-940).
// Framework-free — Node's built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
// chat.js can't be imported under `node --test` (it sits on the api.js → Firebase CDN chain), so — exactly
// like chat-reaction-rollback-guard.test.mjs — the DOM behaviour is pinned with source guards.
//
// THE BUGS (both in messageActionMenu / its call site):
//   1. The Reply menu item's onClick was `() => beginReply(m)` with no setOpen(false), so the menu stayed
//      open + aria-expanded="true" after Reply (Edit/Delete only closed incidentally because they repaint
//      the body). FIX: every item routes through a shared `run(action)` close-then-run wrapper that calls
//      setOpen(false) before the action.
//   2. The long-press (contextmenu) listener was bound to the actions WRAPPER only, so a long-press on the
//      message bubble/row was dead. FIX: the row binds an open-only contextmenu handler via the exposed
//      `open()`, and the trigger's own contextmenu stops propagation so it can't double-fire the row's.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_SRC = readFileSync(join(HERE, "../src/assets/chat.js"), "utf8");

/** Extract the balanced-brace block starting at the first `{` at/after `from` in `src`. */
function braceBlock(src, from) {
  const open = src.indexOf("{", from);
  assert.ok(open > -1, "opening brace found");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  assert.fail("unbalanced braces");
  return ""; // unreachable
}

function messageActionMenuBlock() {
  const fnAt = CHAT_SRC.indexOf("function messageActionMenu");
  assert.ok(fnAt > -1, "messageActionMenu exists in chat.js");
  // Skip past the signature (which has a `{ canReply, canOwn }` destructure) to the function BODY brace.
  const bodyAt = CHAT_SRC.indexOf(") {", fnAt);
  assert.ok(bodyAt > -1, "messageActionMenu has a body");
  return braceBlock(CHAT_SRC, bodyAt);
}

// ── Fix 1: every item closes the menu first (via a shared close-then-run wrapper) ────────────────────

test("messageActionMenu defines a shared close-then-run wrapper that calls setOpen(false) before the action", () => {
  const block = messageActionMenuBlock();
  // The wrapper: `const run = (action) => () => { setOpen(false); action(m); };`
  const runAt = block.indexOf("const run =");
  assert.ok(runAt > -1, "a shared `run` close-then-run wrapper is defined");
  const runDecl = block.slice(runAt, block.indexOf(";", block.indexOf("action(m)", runAt)) + 1);
  assert.match(runDecl, /setOpen\(false\)/, "the run wrapper closes the menu (setOpen(false))");
  assert.ok(
    runDecl.indexOf("setOpen(false)") < runDecl.indexOf("action(m)"),
    "the run wrapper closes the menu BEFORE invoking the action",
  );
});

test("the Reply item's handler goes through the close-then-run wrapper, not a bare beginReply(m)", () => {
  const block = messageActionMenuBlock();
  const replyAt = block.indexOf('"data-testid": "chat-reply"');
  assert.ok(replyAt > -1, "the reply item exists");
  // Its onClick must be `run(beginReply)`, NOT the old `() => beginReply(m)` that left the menu open.
  assert.match(block.slice(replyAt, replyAt + 200), /onClick:\s*run\(beginReply\)/, "reply routes through run()");
  assert.doesNotMatch(
    block.slice(replyAt, replyAt + 200),
    /onClick:\s*\(\)\s*=>\s*beginReply\(m\)/,
    "reply must NOT use the bare handler that leaves aria-expanded=\"true\"",
  );
});

test("edit and delete items also route through the close-then-run wrapper", () => {
  const block = messageActionMenuBlock();
  const editAt = block.indexOf('"data-testid": "chat-edit"');
  const delAt = block.indexOf('"data-testid": "chat-delete"');
  assert.ok(editAt > -1 && delAt > -1, "edit and delete items exist");
  assert.match(block.slice(editAt, editAt + 200), /onClick:\s*run\(beginEdit\)/, "edit routes through run()");
  assert.match(block.slice(delAt, delAt + 200), /onClick:\s*run\(deleteOwnMessage\)/, "delete routes through run()");
});

// ── Fix 2: real long-press on the message row, no double-fire on the trigger ──────────────────────────

test("messageActionMenu exposes an open() and returns it (so the row can wire long-press)", () => {
  const block = messageActionMenuBlock();
  assert.match(block, /const open = \(\) => \{ setOpen\(true\)/, "an open() reveal helper is defined");
  assert.match(block, /return \{ node: wrap, open \}/, "the menu returns { node, open } for the row to consume");
});

function messageRowBlock() {
  const rowFnAt = CHAT_SRC.indexOf("function messageRow");
  assert.ok(rowFnAt > -1, "messageRow exists");
  return braceBlock(CHAT_SRC, rowFnAt);
}

test("the message ROW binds a long-press (contextmenu) handler that opens the menu", () => {
  const rowBlock = messageRowBlock();
  const ctxAt = rowBlock.indexOf('row.addEventListener("contextmenu"');
  assert.ok(ctxAt > -1, "the row has a contextmenu handler");
  const handler = rowBlock.slice(ctxAt, ctxAt + 260);
  assert.match(handler, /menu\.open\(\)/, "the row reveals the menu on long-press (contextmenu → menu.open())");
  assert.match(handler, /e\.preventDefault\(\)/, "it suppresses the native menu on a touch long-press");
});

// ── TM-989/E: the long-press affordance is TOUCH-only; desktop right-click keeps the native menu ──────

test("TM-989/E: the row tracks pointer type and only intercepts a TOUCH-raised contextmenu", () => {
  const rowBlock = messageRowBlock();
  // A pointerdown listener records whether the last pointer was touch/pen (not mouse).
  assert.match(
    rowBlock,
    /row\.addEventListener\("pointerdown"[\s\S]*?pointerType\s*===\s*"touch"/,
    "the row records the last pointer type from pointerdown",
  );
  const ctxAt = rowBlock.indexOf('row.addEventListener("contextmenu"');
  const handler = rowBlock.slice(ctxAt, ctxAt + 260);
  // It bails (native menu preserved) when the last pointer was NOT touch — the desktop right-click fix.
  assert.match(handler, /if\s*\(!lastPointerWasTouch\)\s*return/, "a non-touch (mouse) contextmenu falls through to the native menu");
  // The preventDefault must come AFTER the touch guard, so it can't run on a desktop right-click.
  assert.ok(
    handler.indexOf("lastPointerWasTouch") < handler.indexOf("preventDefault"),
    "the touch guard precedes (gates) the preventDefault",
  );
});

test("the trigger's own contextmenu stops propagation, so long-pressing it doesn't double-fire the row handler", () => {
  const block = messageActionMenuBlock();
  const trigCtxAt = block.indexOf('trigger.addEventListener("contextmenu"');
  assert.ok(trigCtxAt > -1, "the trigger has its own contextmenu handler");
  assert.match(block.slice(trigCtxAt, trigCtxAt + 160), /stopPropagation\(\)/, "it stops propagation to the row");
});

// ── TM-989/F: the role="menu" adds the ARIA arrow-key pattern; Tab stays native (the tm940 contract) ──

test("TM-989/F: the menu keydown adds ArrowUp/ArrowDown/Home/End nav + Escape-closes, and Tab is NOT intercepted", () => {
  const block = messageActionMenuBlock();
  const kdAt = block.indexOf('menu.addEventListener("keydown"');
  assert.ok(kdAt > -1, "the menu has a keydown handler");
  const handler = block.slice(kdAt, block.indexOf("});", kdAt) + 3);
  assert.match(handler, /"ArrowDown"/, "ArrowDown is handled");
  assert.match(handler, /"ArrowUp"/, "ArrowUp is handled");
  assert.match(handler, /"Home"/, "Home is handled");
  assert.match(handler, /"End"/, "End is handled");
  assert.match(handler, /e\.key === "Escape"[\s\S]*setOpen\(false\)/, "Escape closes via setOpen(false)");
  assert.match(handler, /items\[\w+\]\.focus\(\)/, "arrow keys move focus between items");
  // TM-989 e2e regression guard: Tab must NOT be intercepted/closed — native tab order must traverse
  // reply→edit→delete inside the OPEN menu, the behaviour the tm940 spec pins (tm940-message-actions.spec.mjs:153).
  assert.doesNotMatch(handler, /e\.key === "Tab"/, "Tab is NOT intercepted (native traversal; keeps the tm940 contract)");
});
