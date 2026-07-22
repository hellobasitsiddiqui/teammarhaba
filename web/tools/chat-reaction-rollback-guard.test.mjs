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

import {
  applyReactionToggle,
  normaliseReactions,
  shouldRollbackReaction,
  rollbackReactionEmoji,
} from "../src/assets/chat-core.js";

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
//
// TM-989/D: the rollback is now scoped to the ONE emoji the toggle changed (was: a whole-array snapshot).
// This helper mirrors chat.js exactly: capture only this emoji's pre-toggle chip, and on failure restore
// only that chip against the CURRENT array (leaving every other chip — including a concurrent toggle's —
// alone), gated by a per-emoji staleness check.
function startToggle(message, emoji) {
  const { reactions: optimistic } = applyReactionToggle(message.reactions, emoji);
  const prevChip = normaliseReactions(message.reactions).find((r) => r.emoji === emoji) || null;
  message.reactions = optimistic; // optimistic paint
  return { emoji, optimistic, prevChip };
}

function failToggle(message, { emoji, optimistic, prevChip }) {
  const optimisticChip = normaliseReactions(optimistic).find((r) => r.emoji === emoji) || null;
  const currentChip = normaliseReactions(message.reactions).find((r) => r.emoji === emoji) || null;
  const untouched =
    (optimisticChip === null && currentChip === null) ||
    (optimisticChip !== null && currentChip !== null &&
      optimisticChip.count === currentChip.count && optimisticChip.mine === currentChip.mine);
  if (untouched) {
    message.reactions = rollbackReactionEmoji(message.reactions, emoji, prevChip);
    return "rolled-back";
  }
  return "kept-newer-state";
}

test("failure with NO concurrent update rolls the optimistic paint back to the prior chips", () => {
  const prev = [{ emoji: "🎉", count: 2, mine: false }];
  const message = { id: "7", reactions: prev };
  const t = startToggle(message, "👍");

  assert.equal(failToggle(message, t), "rolled-back");
  assert.deepEqual(normaliseReactions(message.reactions), normaliseReactions(prev));
});

test("failure AFTER a concurrent poll reconcile keeps the newer server truth (the TM-854 race)", () => {
  const message = { id: "7", reactions: [] };
  const t = startToggle(message, "👍"); // my optimistic 👍

  // Mid-flight, a poll page lands: another member 🎉'd AND my 👍 count bumped (fresh objects, wholesale replace).
  const fromPoll = normaliseReactions([{ emoji: "👍", count: 2, mine: true }, { emoji: "🎉", count: 1, mine: false }]);
  message.reactions = fromPoll;

  // My request then fails — this emoji's chip changed under me, so we must NOT clobber the poll's truth.
  assert.equal(failToggle(message, t), "kept-newer-state");
  assert.deepEqual(message.reactions, fromPoll);
});

test("TM-989/D: two concurrent toggles on the SAME message, different emoji — a failed one can't resurrect the other's failed chip", () => {
  // Repro: 👍 then ❤️ both fired optimistically on the same message, both requests in flight, both FAIL.
  // Old whole-array rollback: ❤️'s snapshot embedded 👍's optimistic paint, so restoring it after 👍 also
  // failed brought 👍 back — a phantom reaction. Per-emoji rollback keeps them independent.
  const message = { id: "9", reactions: [] };

  const tLike = startToggle(message, "👍"); // paints [👍]
  const tHeart = startToggle(message, "❤️"); // paints [👍, ❤️] — its snapshot sees 👍's paint

  // 👍's request fails first: only 👍's chip is untouched vs its own optimistic → roll 👍 back.
  assert.equal(failToggle(message, tLike), "rolled-back");
  // ❤️ must survive; 👍 must be gone.
  assert.deepEqual(normaliseReactions(message.reactions), normaliseReactions([{ emoji: "❤️", count: 1, mine: true }]));

  // ❤️'s request then also fails: roll ❤️ back too.
  assert.equal(failToggle(message, tHeart), "rolled-back");
  // The message must end EMPTY — no phantom 👍 resurrected by ❤️'s rollback.
  assert.deepEqual(normaliseReactions(message.reactions), [], "no phantom reaction survives both failures");
});

test("TM-989/D: failed toggle leaves a concurrent SUCCESSFUL toggle's chip intact", () => {
  // 👍 and ❤️ both optimistic; ❤️ succeeds (server reconcile) then 👍 fails → 👍 rolls back, ❤️ stays.
  const message = { id: "9", reactions: [] };
  const tLike = startToggle(message, "👍");
  startToggle(message, "❤️"); // paints [👍, ❤️]

  // ❤️ reconciles with server truth (its own success): unchanged here, but 👍's chip is still its paint.
  assert.equal(failToggle(message, tLike), "rolled-back");
  assert.deepEqual(normaliseReactions(message.reactions), normaliseReactions([{ emoji: "❤️", count: 1, mine: true }]));
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

test("chat.js gates the reaction rollback on a per-emoji staleness check inside the thread guard (TM-989/D)", () => {
  const catchBlock = toggleReactionCatchBlock();
  const threadGuardAt = catchBlock.indexOf("thread.id === threadId");
  assert.ok(threadGuardAt > -1, "the thread guard is present in the catch");
  const guardBlock = braceBlock(catchBlock, threadGuardAt);
  // TM-989/D: the rollback is scoped to THIS emoji — the guard compares this emoji's optimistic vs current
  // chip and restores only that chip via rollbackReactionEmoji (was: whole-array shouldRollbackReaction + prev).
  assert.match(guardBlock, /untouched/, "a per-emoji staleness check gates the rollback");
  assert.match(guardBlock, /core\.rollbackReactionEmoji\(/, "rollback restores only THIS emoji's chip");
  const decisionAt = guardBlock.indexOf("const untouched");
  const rollbackAt = guardBlock.indexOf("core.rollbackReactionEmoji(");
  assert.ok(rollbackAt > -1, "the per-emoji rollback write is present");
  assert.ok(decisionAt > -1 && decisionAt < rollbackAt, "the staleness decision guards (precedes) the rollback write");
  // Guard against a regression to the whole-array snapshot that caused the phantom-reaction bug.
  assert.doesNotMatch(guardBlock, /setReactionsOnMessage\(id,\s*prev\)/, "must NOT restore the whole pre-toggle array");
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
