// Regression tests for the event detail action double-tap guard (TM-721). Framework-free — Node's
// built-in test runner, picked up by the CI glob `node --test web/tools/*.test.mjs`.
//
// THE BUG: a detail action button (RSVP / claim / leave) fired its API command and only re-rendered —
// recreating its buttons — once the command resolved. Within that async window a rapid double-tap (or a
// tap on a different action) fired a SECOND command, producing duplicate requests and two contradictory
// toasts ("You're going 🎉" + an error, etc.). runCommand had no in-flight guard.
//
// THE FIX: a module-level `commandInFlight` latch — a second runCommand while one is in flight returns
// immediately — plus disabling the tapped button on click so the busy state is visible, re-enabling it on
// an early bail (checkout/cancel, where no re-render restores it). events.js can't be imported under
// `node --test` (api.js → Firebase CDN chain), so this reimplements the latch + button semantics exactly
// and drives the double-tap through it, then pins the wiring with a source guard.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── The guard, mirrored 1:1 from events.js runCommand ────────────────────────────────────────────────

function makeRunner(command) {
  let commandInFlight = false;
  let commands = 0;
  async function runCommand(button, { bail = false } = {}) {
    if (commandInFlight) return "ignored";
    commandInFlight = true;
    if (button) button.disabled = true;
    let rerendered = false;
    try {
      if (bail) return "bailed"; // checkout took over / confirm cancelled — no command, no re-render
      commands++;
      await command();
      rerendered = true; // renderDetail() would rebuild the buttons here
      return "ran";
    } finally {
      commandInFlight = false;
      if (button && !rerendered) button.disabled = false;
    }
  }
  return { runCommand, commandCount: () => commands };
}

test("a double-tap while a command is in flight fires the command exactly ONCE", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { runCommand, commandCount } = makeRunner(() => gate);
  const btn = { disabled: false };

  const first = runCommand(btn);              // starts, parks on the gate
  assert.equal(btn.disabled, true, "the tapped button is disabled immediately (busy state visible)");
  const second = await runCommand(btn);       // double-tap while first is in flight
  assert.equal(second, "ignored", "the second tap is a no-op");
  assert.equal(commandCount(), 1, "only one command was dispatched");

  release();
  assert.equal(await first, "ran");
});

test("the latch releases after the command settles — a LATER tap runs a fresh command", async () => {
  const { runCommand, commandCount } = makeRunner(async () => {});
  await runCommand({ disabled: false });
  await runCommand({ disabled: false });
  assert.equal(commandCount(), 2, "sequential taps each run (the latch only blocks concurrent ones)");
});

test("an early bail (checkout/cancel) re-enables the button — it isn't left stuck disabled", async () => {
  const { runCommand } = makeRunner(async () => {});
  const btn = { disabled: false };
  const outcome = await runCommand(btn, { bail: true });
  assert.equal(outcome, "bailed");
  assert.equal(btn.disabled, false, "no re-render happened on a bail, so the button is restored");
});

// ── Source guard: events.js keeps the latch + immediate disable wired ─────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS_SRC = readFileSync(join(HERE, "../src/assets/events.js"), "utf8");

test("events.js runCommand has the in-flight latch and disables the tapped button", () => {
  assert.match(EVENTS_SRC, /let\s+commandInFlight\s*=\s*false;/, "the module-level latch exists");
  assert.match(EVENTS_SRC, /if\s*\(commandInFlight\)\s*return;/, "runCommand bails when a command is in flight");
  assert.match(EVENTS_SRC, /if\s*\(button\)\s*button\.disabled\s*=\s*true;/, "the tapped button is disabled on click");
  // The click handler must forward the button element so it can be disabled.
  assert.match(EVENTS_SRC, /onClick:\s*\(e\)\s*=>\s*runCommand\(view,\s*detail,\s*spec,\s*e\.currentTarget\)/);
});
