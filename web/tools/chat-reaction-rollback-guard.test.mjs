// Regression tests for the reaction-toggle rollback guard (TM-854). Framework-free — Node's built-in
// test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG (two halves):
//   1. toggleReaction (chat.js) snapshotted `prev = m.reactions` BEFORE its react/un-react request and,
//      on failure, wrote `prev` back UNCONDITIONALLY. A concurrent poll page / SSE reconcile that landed
//      while the request was in flight (another member's reaction, a fresh server page) was clobbered by
//      that stale pre-request snapshot. Note the poll applies its page WITHOUT bumping thread.rev (rev
//      only tracks live/SSE mutations — TM-721), so the rev machinery cannot see this race.
//   2. The failure toast sat OUTSIDE the `thread.id === threadId` guard, so "Couldn't update your
//      reaction" could pop after the user had already navigated to a different thread.
//
// THE FIX: a pure decision in chat-core — `shouldRollbackReaction(current, optimistic)` — that only
// permits the rollback while the message's chips are still exactly the optimistic value this toggle
// wrote (a VALUE comparison, so a wholesale array replace with identical content still counts as
// untouched); and the toast moved inside the thread guard. chat.js can't be imported under `node --test`
// (it sits on the api.js → Firebase CDN chain), so the DOM half is covered by source guards below,
// exactly like chat-poll-ordering.test.mjs does for TM-721.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { applyReactionToggle, normaliseReactions, shouldRollbackReaction } from "../src/assets/chat-core.js";

// ── The pure decision ────────────────────────────────────────────────────────────────────────────────

test("rollback IS allowed when the chips are untouched since the optimistic paint (same reference)", () => {
  const { reactions: optimistic } = applyReactionToggle([], "👍");
  assert.equal(shouldRollbackReaction(optimistic, optimistic), true);
});

test("rollback IS allowed when the chips were replaced wholesale with identical content (a value check, not identity)", () => {
  // A poll tick swaps in fresh objects; if their VALUE still equals the optimistic paint, nothing newer landed.
  const optimistic = [{ emoji: "👍", count: 1, mine: true }];
  const currentCopy = [{ emoji: "👍", count: 1, mine: true }];
  assert.equal(shouldRollbackReaction(currentCopy, optimistic), true);
});

test("rollback is REFUSED when a concurrent update changed a chip's count mid-flight", () => {
  // I optimistically 👍'd (count 1) … meanwhile another member's 👍 arrived via the poll (count 2).
  const optimistic = [{ emoji: "👍", count: 1, mine: true }];
  const current = [{ emoji: "👍", count: 2, mine: true }];
  assert.equal(shouldRollbackReaction(current, optimistic), false);
});

test("rollback is REFUSED when a concurrent update added a new chip mid-flight", () => {
  const optimistic = [{ emoji: "👍", count: 1, mine: true }];
  const current = [{ emoji: "👍", count: 1, mine: true }, { emoji: "🎉", count: 1, mine: false }];
  assert.equal(shouldRollbackReaction(current, optimistic), false);
});

test("rollback is REFUSED when a concurrent update removed the chip entirely mid-flight", () => {
  const optimistic = [{ emoji: "👍", count: 1, mine: true }];
  assert.equal(shouldRollbackReaction([], optimistic), false);
});

test("rollback is REFUSED when only a `mine` flag differs (a server reconcile disagreed about ownership)", () => {
  const optimistic = [{ emoji: "👍", count: 1, mine: true }];
  const current = [{ emoji: "👍", count: 1, mine: false }];
  assert.equal(shouldRollbackReaction(current, optimistic), false);
});

test("both empty → rollback allowed (an un-react that emptied the chips, still untouched)", () => {
  assert.equal(shouldRollbackReaction([], []), true);
});

test("non-array inputs are normalised, matching the chips' own normalise rule", () => {
  assert.equal(shouldRollbackReaction(null, undefined), true); // both normalise to []
  assert.equal(shouldRollbackReaction(null, [{ emoji: "👍", count: 1, mine: true }]), false);
  // Un-normalised raw vs normalised chips with equal value still compare equal:
  assert.equal(
    shouldRollbackReaction([{ emoji: "👍", count: "1", mine: 1 }], normaliseReactions([{ emoji: "👍", count: 1, mine: true }])),
    true,
  );
});

// ── The failure-path state machine, mirrored from chat.js toggleReaction ─────────────────────────────

/** The failure handler exactly as chat.js now runs it: guarded rollback using the REAL pure decision. */
function failToggle(message, { prev, optimistic }) {
  if (shouldRollbackReaction(message.reactions, optimistic)) {
    message.reactions = prev;
    return "rolled-back";
  }
  return "kept-newer-state";
}

test("failure with NO concurrent update rolls the optimistic paint back to the prior chips", () => {
  const prev = [{ emoji: "🎉", count: 2, mine: false }];
  const message = { id: "7", reactions: prev };
  const { reactions: optimistic } = applyReactionToggle(message.reactions, "👍");
  message.reactions = optimistic; // the optimistic paint

  assert.equal(failToggle(message, { prev, optimistic }), "rolled-back");
  assert.deepEqual(message.reactions, prev);
});

test("failure AFTER a concurrent poll reconcile keeps the newer server truth (the TM-854 race)", () => {
  const prev = [];
  const message = { id: "7", reactions: prev };
  const { reactions: optimistic } = applyReactionToggle(message.reactions, "👍");
  message.reactions = optimistic; // my optimistic 👍

  // Mid-flight, a poll page lands: another member 🎉'd (fresh objects, wholesale replace, rev untouched).
  const fromPoll = normaliseReactions([{ emoji: "👍", count: 1, mine: true }, { emoji: "🎉", count: 1, mine: false }]);
  message.reactions = fromPoll;

  // My request then fails — the stale `prev` snapshot must NOT clobber the poll's newer truth.
  assert.equal(failToggle(message, { prev, optimistic }), "kept-newer-state");
  assert.deepEqual(message.reactions, fromPoll);
});

// ── Source guards: the real chat.js keeps the fix wired (can't import it here) ───────────────────────

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

/** The catch block of toggleReaction — where both halves of the fix live. */
function toggleReactionCatchBlock() {
  const fnAt = CHAT_SRC.indexOf("async function toggleReaction");
  assert.ok(fnAt > -1, "toggleReaction exists in chat.js");
  const fnBlock = braceBlock(CHAT_SRC, fnAt);
  const catchAt = fnBlock.indexOf("catch (err)");
  assert.ok(catchAt > -1, "toggleReaction has a catch block");
  return braceBlock(fnBlock, catchAt);
}

test("chat.js gates the reaction rollback on shouldRollbackReaction inside the thread guard", () => {
  const catchBlock = toggleReactionCatchBlock();
  const threadGuardAt = catchBlock.indexOf("thread.id === threadId");
  assert.ok(threadGuardAt > -1, "the thread guard is present in the catch");
  const guardBlock = braceBlock(catchBlock, threadGuardAt);
  assert.match(guardBlock, /core\.shouldRollbackReaction\(/, "rollback consults the pure staleness decision");
  const decisionAt = guardBlock.indexOf("core.shouldRollbackReaction(");
  const rollbackAt = guardBlock.indexOf("setReactionsOnMessage(id, prev)");
  assert.ok(rollbackAt > -1, "the rollback write is present");
  assert.ok(decisionAt < rollbackAt, "the decision guards (precedes) the rollback write");
});

test("chat.js shows the failure toast INSIDE the thread guard, never after a navigate-away", () => {
  const catchBlock = toggleReactionCatchBlock();
  const threadGuardAt = catchBlock.indexOf("thread.id === threadId");
  assert.ok(threadGuardAt > -1, "the thread guard is present in the catch");
  const guardBlock = braceBlock(catchBlock, threadGuardAt);
  assert.ok(
    guardBlock.includes("Couldn't update your reaction"),
    "the error toast sits inside the thread.id guard block",
  );
});
