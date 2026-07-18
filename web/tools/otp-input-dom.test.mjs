// Fake-DOM harness for the six-box OTP widget's DOM half (TM-867, committed per review) — drives
// otp-input.js's REAL event handlers under `node --test` with ~30 lines of fake elements, so the
// behaviours that live only in the DOM layer (paste preventDefault, focus advance, backspace
// walk-back, the setValue seam TM-407 will call, the collapsed-selection replace-in-place) are on
// the PR gate, not just the main-only e2e run. Importable in Node because otp-input.js depends
// solely on otp-input-core.js — no `https:` Firebase chain (unlike login.js, which is why the
// markup tests are source-level while this one runs the real code).

import assert from "node:assert/strict";
import { test } from "node:test";

import { attachOtpInput } from "../src/assets/otp-input.js";

/**
 * Build a fake role=group of six fake <input> boxes: just enough surface for attachOtpInput —
 * value, addEventListener, focus(), select() — plus a dispatch() helper and shared focus/select
 * logs so tests can assert where focus went and that selections were (re)asserted.
 */
function makeGroup(length = 6) {
  const focusLog = []; // box indexes, in the order they were focused
  const selectLog = []; // box indexes, in the order select() was called
  const boxes = Array.from({ length }, (_, i) => ({
    value: "",
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    dispatch(type, event = {}) {
      (this.listeners[type] ?? []).forEach((fn) => fn(event));
    },
    focus() {
      focusLog.push(i);
    },
    select() {
      selectLog.push(i);
    },
  }));
  const group = { querySelectorAll: () => boxes };
  return { group, boxes, focusLog, selectLog };
}

/** Simulate typing a digit into box i the way select-on-focus intends: value replaced, then input. */
function typeDigit(boxes, i, ch) {
  boxes[i].value = ch;
  boxes[i].dispatch("input");
}

test("typing a digit advances focus box to box and the 6th digit fires onComplete exactly once", () => {
  const { group, boxes, focusLog } = makeGroup();
  const completions = [];
  attachOtpInput({ group, onComplete: (code) => completions.push(code) });

  const code = "493817";
  for (let i = 0; i < 6; i++) {
    typeDigit(boxes, i, code[i]);
    if (i < 5) {
      assert.equal(focusLog.at(-1), i + 1, `digit ${i + 1} advances focus to box ${i + 2}`);
      assert.equal(completions.length, 0, "no completion before the 6th digit");
    }
  }
  assert.deepEqual(completions, [code], "the 6th digit completes exactly once with the code");
  assert.equal(focusLog.at(-1), 5, "focus clamps on the last box");
  boxes.forEach((box, i) => assert.equal(box.value, code[i], `box ${i + 1} renders its digit`));
});

test("a paste event is preventDefault-ed and the sanitised code distributes across all boxes", () => {
  const { group, boxes } = makeGroup();
  const completions = [];
  attachOtpInput({ group, onComplete: (code) => completions.push(code) });

  let prevented = false;
  boxes[2].dispatch("paste", {
    preventDefault: () => {
      prevented = true;
    },
    clipboardData: { getData: () => " 123 456 " }, // space-formatted, landing on a MIDDLE box
  });

  assert.equal(prevented, true, "paste default is prevented (raw string must not enter the box)");
  assert.deepEqual(
    boxes.map((b) => b.value),
    ["1", "2", "3", "4", "5", "6"],
    "a full code pasted anywhere fills from box 1",
  );
  assert.deepEqual(completions, ["123456"], "the distributed paste auto-completes once");
});

test("backspace walks back through the boxes and emptying a box in place clears its slot", () => {
  const { group, boxes, focusLog } = makeGroup();
  attachOtpInput({ group, onComplete: () => {} });
  const noopPrevent = { key: "Backspace", preventDefault: () => {} };

  typeDigit(boxes, 0, "1");
  typeDigit(boxes, 1, "2");
  typeDigit(boxes, 2, "3"); // focus now sits on box 4 (index 3), which is empty

  // Backspace on the EMPTY box 4 clears box 3 and steps onto it…
  boxes[3].dispatch("keydown", noopPrevent);
  assert.equal(boxes[2].value, "", "empty-box backspace clears the previous box");
  assert.equal(focusLog.at(-1), 2, "…and moves focus onto it");

  // …then backspace on the now-EMPTY box 3 clears box 2 and steps onto it.
  boxes[2].dispatch("keydown", noopPrevent);
  assert.equal(boxes[1].value, "", "second backspace walks another box left");
  assert.equal(focusLog.at(-1), 1);
  assert.equal(boxes[0].value, "1", "box 1 is untouched");

  // Emptying a filled box IN PLACE (select-all + delete / cut) clears the slot, focus stays put.
  const focusCountBefore = focusLog.length;
  boxes[0].value = "";
  boxes[0].dispatch("input");
  assert.equal(boxes[0].value, "", "the emptied box stays empty (state adopted the clear)");
  assert.equal(focusLog.length, focusCountBefore, "an in-place clear moves no focus");
});

test("setValue() — the TM-407 native-autofill seam — fills every box and fires onComplete", () => {
  const { group, boxes } = makeGroup();
  const completions = [];
  const widget = attachOtpInput({ group, onComplete: (code) => completions.push(code) });

  widget.setValue("123456");

  assert.deepEqual(
    boxes.map((b) => b.value),
    ["1", "2", "3", "4", "5", "6"],
    "setValue distributes the whole code",
  );
  assert.deepEqual(completions, ["123456"], "setValue fires the SAME complete callback as typing");
  assert.equal(widget.value(), "123456", "value() reads the assembled code back");
});

test("a collapsed-selection insert into a filled box replaces THAT digit, never the neighbour", () => {
  // Chrome/Safari collapse the focus-handler select() on mouseup, so typing into a filled box can
  // INSERT beside the old digit (value "28" = stored "2" + typed "8"). The handler must treat that
  // as replace-in-place — the old bug spilled the new digit into the NEXT box and auto-submitted a
  // doubly-wrong code (TM-867 review fix).
  const { group, boxes } = makeGroup();
  const completions = [];
  const widget = attachOtpInput({ group, onComplete: (code) => completions.push(code) });
  widget.setValue("123456"); // completions: ["123456"]

  // Caret AFTER the old digit: box 2 (stored "2") becomes "28" — typed "8" replaces in place.
  boxes[1].value = "28";
  boxes[1].dispatch("input");
  assert.equal(boxes[1].value, "8", "the typed digit replaces the box's own digit");
  assert.equal(boxes[2].value, "3", "the neighbour box keeps its digit");
  assert.equal(completions.at(-1), "183456", "the re-completed code is the corrected one");

  // Caret BEFORE the old digit: box 5 (stored "5") becomes "95" — typed "9" still replaces box 5.
  boxes[4].value = "95";
  boxes[4].dispatch("input");
  assert.equal(boxes[4].value, "9");
  assert.equal(boxes[5].value, "6", "the last box keeps its digit");
  assert.equal(completions.at(-1), "183496");
});

test("pointer/mouse-up on a box re-asserts the selection (select-on-focus collapse counter)", () => {
  const { group, boxes, selectLog } = makeGroup();
  attachOtpInput({ group, onComplete: () => {} });

  for (const type of ["pointerup", "mouseup"]) {
    let prevented = false;
    const before = selectLog.length;
    boxes[0].dispatch(type, {
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true, `${type} default (caret placement) is prevented`);
    assert.equal(selectLog.length, before + 1, `${type} re-selects the box content`);
  }
});
